// Editorial left-hand shell used by Login + the 3 onboarding steps.
//
// Composes the ZorEWS brand mark, a live monitoring ticker, and a
// list of security highlights into a dark-navy splash. The right-hand
// content (form / cards) is supplied as children so each step can
// keep its own form state local.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ShieldCheck, Activity, Lock, BadgeCheck, Globe2 } from 'lucide-react';
import { cn } from '@/lib/cn';

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

const HIGHLIGHTS = [
  {
    icon: Lock,
    title: 'Bank-grade security',
    detail: 'TOTP MFA · Hash-chained audit · Per-tenant KMS envelope encryption',
  },
  {
    icon: ShieldCheck,
    title: 'Regulator-ready compliance',
    detail: 'RBI · IRDAI · MAS · OCC · CECL · Solvency II · Basel III',
  },
  {
    icon: BadgeCheck,
    title: 'Multi-country, multi-tenant',
    detail: 'Tenant isolation enforced at every layer — data, audit, scoring',
  },
];

export interface EnterpriseShellProps {
  /** Right-pane content (form card or step body). */
  children: ReactNode;
  /** When true, show a compact step indicator above the brand mark. */
  step?: { current: number; total: number; label: string };
  /** Override the default "AI-Powered Risk Intelligence Platform" tagline. */
  tagline?: string;
}

export function EnterpriseShell({ children, step, tagline }: EnterpriseShellProps) {
  const [tickerIdx, setTickerIdx] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setTickerIdx((i) => (i + 1) % TICKER.length);
    }, 4200);
    return () => window.clearInterval(id);
  }, []);

  const current = TICKER[tickerIdx];
  const heading = useMemo(() => tagline ?? 'AI-Powered Risk Intelligence Platform', [tagline]);

  return (
    <div className="min-h-screen w-full bg-ews-midnight text-ews-warmWhite flex flex-col lg:flex-row">
      {/* ── LEFT (60%) — editorial splash ── */}
      <aside
        className={cn(
          'relative isolate overflow-hidden',
          'lg:w-3/5 lg:min-h-screen px-8 py-10 lg:px-14 lg:py-12',
          'flex flex-col justify-between gap-12',
        )}
      >
        {/* atmospheric depth */}
        <BackgroundFX />

        {/* top: brand + step */}
        <header className="relative z-10 flex items-start justify-between gap-6">
          <div className="flex items-center gap-3">
            <BrandMark />
            <div>
              <p className="font-display text-[22px] leading-none font-semibold tracking-tight">
                Zor<span className="text-ews-orange">EWS</span>
              </p>
              <p className="text-[11px] uppercase tracking-[0.18em] text-ews-warmWhite/55 mt-1">
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

        {/* middle: headline + live ticker */}
        <section className="relative z-10 max-w-[560px]">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-ews-orange mb-5 flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-ews-orange animate-pulse" />
            Live monitoring · global
          </p>
          <h1 className="font-display text-[44px] lg:text-[52px] leading-[1.05] font-medium tracking-tight">
            {heading}
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-ews-warmWhite/75 max-w-[480px]">
            Detect borrower stress, claim fraud, lapse signals and operational risk weeks before
            they breach — across every branch, division, and regulator you operate under.
          </p>

          <div className="mt-10">
            <div className="rounded-lg border border-ews-line/80 bg-ews-deepNavy/70 backdrop-blur-sm p-5">
              <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.2em] text-ews-warmWhite/55 mb-3">
                <Activity size={11} className="text-ews-orange" />
                <span>Live · synthetic seed</span>
                <span className="ml-auto font-mono">
                  {String(tickerIdx + 1).padStart(2, '0')} / {String(TICKER.length).padStart(2, '0')}
                </span>
              </div>
              <div key={tickerIdx} className="animate-[fadein_400ms_ease-out]">
                <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ews-warmWhite/55">
                  {current.label}
                </p>
                <p className="font-display text-[40px] font-semibold leading-none mt-2 text-ews-warmWhite">
                  {current.value}
                </p>
                <p className="mt-2 text-[12.5px] text-ews-warmWhite/65">{current.detail}</p>
              </div>
            </div>
          </div>
        </section>

        {/* bottom: security highlights */}
        <footer className="relative z-10 grid grid-cols-1 sm:grid-cols-3 gap-5">
          {HIGHLIGHTS.map((h) => (
            <div key={h.title} className="flex gap-3">
              <div className="shrink-0 h-9 w-9 rounded-md bg-ews-orange/12 border border-ews-orange/30 flex items-center justify-center">
                <h.icon size={15} className="text-ews-orange" strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold leading-tight">{h.title}</p>
                <p className="text-[11px] text-ews-warmWhite/55 leading-snug mt-1">{h.detail}</p>
              </div>
            </div>
          ))}
        </footer>
      </aside>

      {/* ── RIGHT (40%) — caller-controlled content ── */}
      <main className="lg:w-2/5 lg:min-h-screen bg-ews-ivory text-ink flex items-center justify-center px-6 py-10 lg:px-12 relative">
        <div className="absolute top-0 right-0 h-32 w-32 lg:hidden bg-ews-orange/8 rounded-bl-full" />
        <div className="w-full max-w-[420px] relative">{children}</div>
      </main>

      {/* tiny global keyframe for the ticker fade-in */}
      <style>{`
        @keyframes fadein {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ── Atmospheric background — gradient mesh + corner glow + grid ─────

function BackgroundFX() {
  return (
    <>
      {/* warm radial glow top-right */}
      <div
        className="absolute -top-32 -right-24 h-[480px] w-[480px] rounded-full pointer-events-none opacity-40"
        style={{
          background:
            'radial-gradient(closest-side, rgba(255,107,53,0.18), rgba(255,107,53,0) 70%)',
        }}
      />
      {/* cool deep glow bottom-left */}
      <div
        className="absolute -bottom-40 -left-32 h-[520px] w-[520px] rounded-full pointer-events-none opacity-50"
        style={{
          background:
            'radial-gradient(closest-side, rgba(21,35,75,0.95), rgba(21,35,75,0) 70%)',
        }}
      />
      {/* faint dot grid */}
      <div
        className="absolute inset-0 opacity-[0.07] pointer-events-none"
        style={{
          backgroundImage:
            'radial-gradient(rgba(245,241,232,0.45) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />
      {/* hairline orange streak — editorial flourish */}
      <div className="absolute left-14 lg:left-[3.5rem] top-[42%] h-px w-12 bg-ews-orange/70" aria-hidden />
    </>
  );
}

// ── Brand mark — bespoke geometric shield ─────────────────────────────

function BrandMark() {
  return (
    <div className="relative h-11 w-11 shrink-0">
      <div className="absolute inset-0 rounded-md bg-ews-orange" />
      <div className="absolute inset-[3px] rounded-[5px] bg-ews-midnight border border-ews-orange/70 flex items-center justify-center">
        <Globe2 size={20} className="text-ews-orange" strokeWidth={1.5} />
      </div>
    </div>
  );
}
