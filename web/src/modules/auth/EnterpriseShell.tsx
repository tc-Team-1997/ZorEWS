// Editorial left-hand shell used by Login + the 3 onboarding steps.
//
// Banking-grade gradient background, ZorEWS brand, 6 spec'd feature
// highlights, a live monitoring ticker, the Banking/Insurance
// illustration, and the ZorFinotech footer. Right-hand content
// (form / cards) is supplied as children — wrapped in a white
// glassmorphism card with subtle blur + ring.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  BadgeCheck,
  BrainCircuit,
  Database,
  Eye,
  Globe2,
  Lock,
  ShieldCheck,
  Wand2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { BankingIllustration } from './BankingIllustration';

interface TickerLine {
  label: string;
  value: string;
  detail: string;
}

const TICKER: TickerLine[] = [
  { label: 'Customers monitored', value: '10,000+', detail: 'Across 6 countries · 14 tenants' },
  { label: 'Live high-risk', value: '412', detail: 'PD ≥ 5% · Recalculated every 60s' },
  { label: 'Open cases', value: '64', detail: 'BAC-A workflow · SLA breach: 7' },
  { label: 'Alerts last 24h', value: '2,527', detail: 'Red 8% · Orange 21% · Yellow 71%' },
  { label: 'Models in production', value: '8', detail: 'PD · Fraud · Lapse · Claim severity' },
  { label: 'Indicators evaluated', value: '32', detail: '4 banking + 5 insurance families' },
];

const FEATURES: { icon: typeof Database; label: string }[] = [
  { icon: Database, label: 'Built-in Data Cleaning' },
  { icon: BrainCircuit, label: 'AI on every screen' },
  { icon: Wand2, label: 'Zero hard-coding' },
  { icon: Eye, label: 'Explainable AI' },
  { icon: ShieldCheck, label: 'Fraud & NPA detection' },
  { icon: Lock, label: 'Enterprise-grade security' },
];

export interface EnterpriseShellProps {
  /** Right-pane content (form card or step body). */
  children: ReactNode;
  /** When true, show a compact step indicator above the brand mark. */
  step?: { current: number; total: number; label: string };
  /** Override the default tagline. */
  tagline?: string;
  /** Hide the Banking/Insurance illustration — useful for onboarding
   *  pages where the right pane carries more form rows and wants the
   *  left to stay text-only. */
  hideIllustration?: boolean;
}

export function EnterpriseShell({
  children,
  step,
  tagline,
  hideIllustration,
}: EnterpriseShellProps) {
  const [tickerIdx, setTickerIdx] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setTickerIdx((i) => (i + 1) % TICKER.length);
    }, 4200);
    return () => window.clearInterval(id);
  }, []);

  const current = TICKER[tickerIdx];
  const heading = useMemo(
    () => tagline ?? 'AI-powered risk intelligence platform for Banking and Insurance',
    [tagline],
  );

  return (
    <div className="min-h-screen w-full text-ews-warmWhite flex flex-col lg:flex-row relative overflow-hidden">
      {/* base — deep navy → royal blue radial gradient covers the
          whole viewport so the right glassmorphism card has something
          to refract */}
      <GlobalBackdrop />

      {/* ── LEFT (55%) — branding + features + illustration ── */}
      <aside
        className={cn(
          'relative isolate overflow-hidden',
          'lg:w-[55%] lg:min-h-screen px-7 py-10 lg:px-12 lg:py-10',
          'flex flex-col justify-between gap-8',
        )}
      >
        <PanelBackdrop />

        {/* top: brand + step */}
        <header className="relative z-10 flex items-start justify-between gap-6">
          <div className="flex items-center gap-3">
            <BrandMark />
            <div>
              <p className="font-display text-[22px] leading-none font-semibold tracking-tight">
                Zor<span className="text-ews-orange">EWS</span>
              </p>
              <p className="text-[10.5px] uppercase tracking-[0.22em] text-ews-warmWhite/55 mt-1.5">
                Early Warning System
              </p>
            </div>
          </div>
          {step && (
            <div className="hidden lg:flex items-center gap-3">
              <span className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-ews-warmWhite/55">
                {step.label}
              </span>
              <div className="flex items-center gap-1.5">
                {Array.from({ length: step.total }).map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-[3px] w-7 rounded-sm transition-colors',
                      i + 1 < step.current && 'bg-ews-orange',
                      i + 1 === step.current && 'bg-ews-orange',
                      i + 1 > step.current && 'bg-ews-warmWhite/15',
                    )}
                  />
                ))}
              </div>
              <span className="font-mono text-[10.5px] text-ews-warmWhite/55">
                {step.current.toString().padStart(2, '0')} / {step.total.toString().padStart(2, '0')}
              </span>
            </div>
          )}
        </header>

        {/* middle: tagline + live monitoring ticker */}
        <section className="relative z-10 max-w-[560px]">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-ews-orange mb-4 flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-ews-orange animate-pulse" />
            Live monitoring · global
          </p>
          <h1 className="font-display text-[34px] lg:text-[42px] leading-[1.06] font-medium tracking-tight">
            Early Warning System
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-ews-warmWhite/80 max-w-[460px]">
            {heading}
          </p>

          {/* Live ticker — kept compact so the illustration fits beneath */}
          <div className="mt-6 max-w-[440px]">
            <div className="rounded-xl border border-white/8 bg-white/[0.045] backdrop-blur-md px-4 py-3.5">
              <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.2em] text-ews-warmWhite/55 mb-2">
                <Activity size={11} className="text-ews-orange" />
                <span>Live · synthetic seed</span>
                <span className="ml-auto font-mono">
                  {String(tickerIdx + 1).padStart(2, '0')} / {String(TICKER.length).padStart(2, '0')}
                </span>
              </div>
              <div key={tickerIdx} className="animate-[fadein_400ms_ease-out] grid grid-cols-[auto_1fr] items-end gap-x-4 gap-y-1">
                <p className="font-display text-[34px] font-semibold leading-none text-ews-warmWhite">
                  {current.value}
                </p>
                <div className="pb-1">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ews-warmWhite/55">
                    {current.label}
                  </p>
                  <p className="text-[11px] text-ews-warmWhite/70 leading-tight mt-0.5">
                    {current.detail}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {!hideIllustration && (
            <div className="mt-6 max-w-[460px] hidden md:block">
              <BankingIllustration className="w-full h-auto" />
            </div>
          )}
        </section>

        {/* bottom: 6 feature highlights + footer */}
        <footer className="relative z-10 space-y-5">
          <ul className="grid grid-cols-2 gap-x-5 gap-y-2.5">
            {FEATURES.map((f) => (
              <li key={f.label} className="flex items-center gap-2.5">
                <span className="h-5 w-5 rounded-sm bg-ews-orange/15 border border-ews-orange/30 inline-flex items-center justify-center shrink-0">
                  <f.icon size={11} className="text-ews-orange" strokeWidth={2} />
                </span>
                <span className="text-[12px] text-ews-warmWhite/85">{f.label}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-white/8 pt-4 text-[10.5px] font-mono text-ews-warmWhite/45">
            <span>© 2026 ZorFinotech</span>
            <span className="flex items-center gap-1.5">
              <BadgeCheck size={11} className="text-ews-orange" />
              SOC 2 · ISO 27001 · RBI BAC-A
            </span>
          </div>
        </footer>
      </aside>

      {/* ── RIGHT (45%) — glassmorphism card ── */}
      <main className="relative lg:w-[45%] lg:min-h-screen flex items-center justify-center px-5 py-10 lg:px-10">
        {/* subtle right-side glow */}
        <div
          className="absolute top-1/2 -right-32 h-[460px] w-[460px] -translate-y-1/2 rounded-full opacity-50 pointer-events-none"
          style={{
            background:
              'radial-gradient(closest-side, rgba(255,107,53,0.20), rgba(255,107,53,0) 70%)',
          }}
        />
        <div className="relative w-full max-w-[440px]">
          <div
            className={cn(
              'rounded-2xl bg-white/95 backdrop-blur-xl shadow-[0_24px_70px_-30px_rgba(10,20,48,0.6)]',
              'ring-1 ring-white/40 border border-white/30',
              'text-ink px-6 py-7 lg:px-8 lg:py-8',
            )}
          >
            {children}
          </div>
        </div>
      </main>

      <style>{`
        @keyframes fadein {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ── Backdrop layers ─────────────────────────────────────────────────

function GlobalBackdrop() {
  return (
    <div className="absolute inset-0 -z-10 pointer-events-none">
      {/* base linear gradient — navy → royal blue */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(115deg, #060D24 0%, #0A1430 35%, #11296D 75%, #1B3CA8 100%)',
        }}
      />
      {/* spotlight from upper right */}
      <div
        className="absolute inset-0 opacity-90"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 60% 50% at 80% 0%, rgba(80,130,255,0.18), transparent 60%)',
        }}
      />
      {/* warm orange wash bottom-left for accent */}
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle 40% at 10% 110%, rgba(255,107,53,0.18), transparent 60%)',
        }}
      />
      {/* faint dot grid overlay */}
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'radial-gradient(rgba(245,241,232,0.45) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      />
    </div>
  );
}

function PanelBackdrop() {
  return (
    <>
      {/* hairline orange streak — editorial flourish */}
      <div className="absolute left-12 top-[44%] h-px w-12 bg-ews-orange/70" aria-hidden />
      {/* subtle vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(to bottom right, rgba(10,20,48,0.4), transparent 60%)',
        }}
      />
    </>
  );
}

// ── Brand mark ─────────────────────────────────────────────────────

function BrandMark() {
  return (
    <div className="relative h-11 w-11 shrink-0">
      <div className="absolute inset-0 rounded-md bg-ews-orange shadow-[0_4px_14px_-4px_rgba(255,107,53,0.6)]" />
      <div className="absolute inset-[3px] rounded-[5px] bg-ews-midnight border border-ews-orange/70 flex items-center justify-center">
        <Globe2 size={20} className="text-ews-orange" strokeWidth={1.5} />
      </div>
    </div>
  );
}
