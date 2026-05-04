import { useEffect, useState, type CSSProperties } from 'react';
import {
  AlertTriangle,
  Brain,
  Workflow as WorkflowIcon,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

interface Slide {
  icon: LucideIcon;
  title: string;
  body: string;
}
const SLIDES: readonly Slide[] = [
  {
    icon: AlertTriangle,
    title: 'Spot risk before delinquency.',
    body: 'Indicator + rule engines flag distress 30–60 days before DPD — across financial, behavioural, transaction, and credit signals.',
  },
  {
    icon: Brain,
    title: 'AI-driven PD scoring.',
    body: 'Gradient-boosted probability-of-default with SHAP reason codes. Champion/challenger registry and drift monitoring built in.',
  },
  {
    icon: WorkflowIcon,
    title: 'Connected Collection workflow.',
    body: 'Smart-prioritised alerts auto-route into a single case ID across EWS and Collection — full action log, GPS-aware mobile.',
  },
  {
    icon: ShieldCheck,
    title: 'Banking-grade compliance.',
    body: 'Kenya DPA 2019 + ISO 27001 control mapping, hash-chain audit on S3 Object Lock, multi-region DR posture.',
  },
] as const;

const SLIDE_INTERVAL_MS = 5200;

export function CarouselPanel() {
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
            <ShieldCheck size={16} className="text-white" strokeWidth={2.25} />
          </div>
          <div>
            <p className="text-white text-[13px] font-semibold leading-tight">APEX EWS</p>
            <p className="text-white/60 text-[10px] leading-tight">Early Warning System</p>
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
