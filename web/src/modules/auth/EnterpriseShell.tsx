// Editorial left-hand shell used by Login + the 3 onboarding steps.
//
// Wireframe-faithful: dark navy background, plain `Zor[orange]EWS[/orange]`
// text logo, bold headline, paragraph, 4-feature vertical list, footer.
// Deliberately spare — no live ticker, no illustration, no compliance
// ribbon, no atmospheric gradient mesh. The richness lives on the
// right-hand login card, not the brand panel.

import { useMemo, type ReactNode } from 'react';
import { GraduationCap, Settings2, Sparkles, Wand2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const FEATURES: { icon: typeof Wand2; label: string; description: string }[] = [
  {
    icon: Wand2,
    label: 'Built-in Data Cleaning',
    description: 'Profile, standardise and reconcile every feed before it reaches your models.',
  },
  {
    icon: Sparkles,
    label: 'AI on every screen',
    description: 'Every module has a context-aware AI co-pilot that explains, forecasts and recommends.',
  },
  {
    icon: Settings2,
    label: 'Zero hard-coding',
    description: 'Every threshold, rule, weight and bucket is editable from Master Setup.',
  },
  {
    icon: GraduationCap,
    label: 'Self-explanatory UI',
    description: 'Every screen tells you what it does, who uses it, and where the data comes from.',
  },
];

export interface EnterpriseShellProps {
  /** Right-pane content (form card or step body). */
  children: ReactNode;
  /** When true, show a compact step indicator above the brand mark. */
  step?: { current: number; total: number; label: string };
  /** Override the default paragraph copy under the headline. */
  tagline?: string;
}

export function EnterpriseShell({ children, step, tagline }: EnterpriseShellProps) {
  const heading = useMemo(
    () =>
      tagline ??
      'Spot stress signals before they become NPAs, claims spikes, or solvency breaches. AI-powered early-warning for banks and insurers — one platform, two domains.',
    [tagline],
  );

  return (
    <div className="min-h-screen w-full text-ews-warmWhite flex flex-col lg:flex-row relative overflow-hidden">
      {/* base — solid deep navy with a very subtle vertical depth.
          Deliberately simple to match the wireframe. */}
      <GlobalBackdrop />

      {/* ── LEFT (55%) — wireframe-faithful brand panel ── */}
      <aside
        className={cn(
          'relative isolate',
          'lg:w-[55%] lg:min-h-screen px-8 py-10 lg:px-14 lg:py-12',
          'flex flex-col gap-12',
        )}
      >
        {/* top: text-only ZorEWS logo + optional step indicator */}
        <header className="relative z-10 flex items-start justify-between gap-6">
          <p className="font-sans text-[26px] font-bold tracking-tight leading-none">
            Zor<span className="text-ews-orange">EWS</span>
          </p>
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
                      i + 1 <= step.current && 'bg-ews-orange',
                      i + 1 > step.current && 'bg-ews-warmWhite/15',
                    )}
                  />
                ))}
              <span className="font-mono text-[10.5px] text-ews-warmWhite/55 ml-1">
                {step.current.toString().padStart(2, '0')} / {step.total.toString().padStart(2, '0')}
              </span>
              </div>
            </div>
          )}
        </header>

        {/* middle: headline + paragraph + 4-feature list. Flex-grows so
            the footer hugs the bottom and the content breathes. */}
        <section className="relative z-10 flex-1 flex flex-col gap-10 max-w-[560px]">
          <div>
            <h1 className="font-sans text-[52px] lg:text-[60px] leading-[1.02] font-bold tracking-tight text-ews-warmWhite">
              Early Warning
              <br />
              System
            </h1>
            <p className="mt-7 text-[15px] leading-[1.65] text-ews-warmWhite/70 max-w-[520px]">
              {heading}
            </p>
          </div>

          <ul className="space-y-5">
            {FEATURES.map((f) => (
              <li key={f.label} className="flex items-start gap-4">
                <span className="h-10 w-10 rounded-full bg-ews-orange/12 border border-ews-orange/30 inline-flex items-center justify-center shrink-0">
                  <f.icon size={17} className="text-ews-orange" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-[15px] font-semibold text-ews-warmWhite leading-tight">{f.label}</p>
                  <p className="text-[13px] text-ews-warmWhite/60 leading-snug mt-1.5">{f.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* bottom: footer text only */}
        <footer className="relative z-10 text-[12px] text-ews-warmWhite/45">
          © 2026 ZorFinotech · ZorEWS v1.0 · For demonstration purposes
        </footer>
      </aside>

      {/* ── RIGHT (45%) — dark navy elevated card ── */}
      <main className="relative lg:w-[45%] lg:min-h-screen flex items-center justify-center px-5 py-10 lg:px-10">
        {/* subtle orange wash bleeds into the dark card — adds the
            "premium banking" warmth without going white */}
        <div
          className="absolute top-1/2 -right-32 h-[440px] w-[440px] -translate-y-1/2 rounded-full opacity-50 pointer-events-none"
          style={{
            background:
              'radial-gradient(closest-side, rgba(255,107,53,0.22), rgba(255,107,53,0) 70%)',
          }}
        />
        <div className="relative w-full max-w-[440px]">
          <div
            className={cn(
              // Dark elevated card — translucent deep-navy + backdrop
              // blur reads as glassmorphism on a darker base. White
              // hairline ring + 1px border give the edge definition.
              'rounded-2xl bg-ews-deepNavy/55 backdrop-blur-xl',
              'shadow-[0_24px_70px_-30px_rgba(0,0,0,0.6)]',
              'ring-1 ring-white/10 border border-white/8',
              'text-ews-warmWhite px-6 py-7 lg:px-8 lg:py-8',
            )}
          >
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

// ── Backdrop — deliberately spare. Solid navy + a soft vertical
//    darkening; nothing else. Keeps the wireframe's calm tone. ─────

function GlobalBackdrop() {
  return (
    <div className="absolute inset-0 -z-10 pointer-events-none">
      {/* solid navy base */}
      <div className="absolute inset-0 bg-ews-midnight" />
      {/* very gentle vertical depth — top is a hair lighter than bottom */}
      <div
        className="absolute inset-0 opacity-90"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(21,35,75,0.35) 0%, rgba(10,20,48,0) 70%)',
        }}
      />
    </div>
  );
}
