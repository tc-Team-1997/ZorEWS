import { useEffect, useState, type CSSProperties } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Navigate, useNavigate } from 'react-router-dom';
import { FileText, ShieldCheck, Workflow as WorkflowIcon, Search as SearchIcon, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Button, Input } from '@/components/ui';

const schema = z.object({
  username: z.string().min(1, 'Username required'),
  password: z.string().min(1, 'Password required'),
});
type FormData = z.infer<typeof schema>;

// ── Carousel content — DocManager value props ─────────────────────────────
interface Slide {
  icon: LucideIcon;
  title: string;
  body: string;
}
const SLIDES: readonly Slide[] = [
  {
    icon: FileText,
    title: 'Capture, classify, index.',
    body: 'Multi-channel capture from branch scanners, mobile, email, and portal — OCR and AI classification in one pipeline.',
  },
  {
    icon: WorkflowIcon,
    title: 'Maker–checker workflows.',
    body: 'Configurable approval chains with full audit, escalation, and step-up authentication for high-risk documents.',
  },
  {
    icon: SearchIcon,
    title: 'Enterprise search across branches.',
    body: 'Full-text across OCR, metadata, and customer records — results scoped by branch, role, and risk band.',
  },
  {
    icon: ShieldCheck,
    title: 'Banking-grade compliance.',
    body: 'CBE retention policies, WORM archival, signature chain of custody, and tenant-isolated encryption at rest.',
  },
] as const;

const SLIDE_INTERVAL_MS = 5200;

function CarouselPanel() {
  const [idx, setIdx] = useState(0);
  const [prevIdx, setPrevIdx] = useState<number | null>(null);

  useEffect(() => {
    const t = setInterval(() => {
      setIdx((i) => {
        setPrevIdx(i);
        return (i + 1) % SLIDES.length;
      });
    }, SLIDE_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (prevIdx === null) return;
    const t = setTimeout(() => setPrevIdx(null), 950);
    return () => clearTimeout(t);
  }, [prevIdx]);

  const jump = (next: number) => {
    if (next === idx) return;
    setPrevIdx(idx);
    setIdx(next);
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-brand-navy">
      <div
        className="absolute inset-0 opacity-[0.10] auth-grid"
        style={{
          backgroundImage: 'radial-gradient(circle, #ffffff 1px, transparent 1px)',
          backgroundSize: '18px 18px',
        }}
      />
      <div className="auth-blob-a absolute -top-24 -right-24 w-[460px] h-[460px] rounded-full bg-brand-blue/35 blur-3xl" />
      <div className="auth-blob-b absolute -bottom-32 -left-16 w-[380px] h-[380px] rounded-full bg-brand-sky/25 blur-3xl" />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 40%, rgba(255,255,255,0.03) 100%)',
        }}
      />

      <div className="relative h-full flex flex-col justify-between p-10">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-brand-blue rounded-lg flex items-center justify-center shadow-lg shadow-brand-blue/30">
            <FileText size={16} className="text-white" strokeWidth={2.25} />
          </div>
          <div>
            <p className="text-white text-[13px] font-semibold leading-tight">DocManager</p>
            <p className="text-white/60 text-[10px] leading-tight">Enterprise Document Management</p>
          </div>
        </div>

        <div className="relative min-h-[220px]">
          {SLIDES.map((slide, i) => {
            const Icon = slide.icon;
            const state = i === idx ? 'is-active' : i === prevIdx ? 'is-leaving' : '';
            return (
              <div key={i} className={`auth-slide ${state}`}>
                <div className="auth-slide-child auth-slide-child--icon w-14 h-14 rounded-2xl bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center mb-5 shadow-xl shadow-black/20">
                  <Icon size={24} className="text-white" strokeWidth={1.75} />
                </div>
                <h2 className="auth-slide-child auth-slide-child--title text-white text-[26px] font-semibold leading-[1.15] tracking-tight mb-3 max-w-md">
                  {slide.title}
                </h2>
                <p className="auth-slide-child auth-slide-child--body text-white/70 text-[13px] leading-relaxed max-w-md">
                  {slide.body}
                </p>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {SLIDES.map((_, i) => {
            const active = i === idx;
            const style = active
              ? ({ '--auth-interval': `${SLIDE_INTERVAL_MS}ms` } as CSSProperties)
              : undefined;
            return (
              <button
                key={i}
                type="button"
                onClick={() => jump(i)}
                aria-label={`Slide ${i + 1}`}
                className={`relative h-1.5 rounded-full overflow-hidden transition-all duration-500 ease-out ${
                  active ? 'w-10 bg-white/25' : 'w-1.5 bg-white/40 hover:bg-white/60'
                }`}
              >
                {active && (
                  <span
                    key={`bar-${idx}`}
                    className="auth-dot-active-bar absolute inset-0 bg-white rounded-full"
                    style={style}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const login = useAuth((s) => s.login);
  const status = useAuth((s) => s.status);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async ({ username, password }) => {
    setServerError(null);
    try {
      await login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) setServerError('Invalid credentials. Please try again.');
      else if (err instanceof HttpError && err.status === 403) setServerError('Account is locked. Contact your administrator.');
      else setServerError('Sign-in failed. Please try again.');
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
              <FileText size={14} className="text-white" strokeWidth={2.25} />
            </div>
            <div>
              <p className="text-ink text-sm font-semibold leading-tight">DocManager</p>
              <p className="text-muted text-[11px]">Enterprise Document Management</p>
            </div>
          </div>

          <div className="hidden lg:flex w-10 h-10 bg-brand-blue rounded-xl items-center justify-center mb-4 shadow-sm">
            <ShieldCheck size={18} className="text-white" strokeWidth={2} />
          </div>

          <h2 className="text-xl font-semibold text-ink mb-1 tracking-tight">Sign in</h2>
          <p className="text-[13px] text-sub mb-5">Document operations for authorised staff only</p>

          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <Input
              {...register('username')}
              label="Username"
              autoComplete="username"
              placeholder="your.username"
              error={errors.username?.message ?? ''}
              required
            />
            <Input
              {...register('password')}
              type="password"
              label="Password"
              autoComplete="current-password"
              placeholder="••••••••"
              error={errors.password?.message ?? ''}
              required
            />

            {serverError && (
              <p className="text-[11px] text-danger bg-danger-bg border border-danger/20 rounded px-3 py-1.5">
                {serverError}
              </p>
            )}

            <Button type="submit" className="w-full" loading={isSubmitting}>
              Sign in
            </Button>
          </form>

          <div className="mt-4 pt-4 border-t border-divider">
            <p className="text-center text-[11px] text-muted">
              Demo accounts · <span className="font-mono">admin/admin123</span>{' '}
              · <span className="font-mono">sara/sara123</span>{' '}
              · <span className="font-mono">mohamed/mohamed123</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
