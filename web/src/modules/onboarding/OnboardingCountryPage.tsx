// STEP 1 — Country Selection.
//
// First stop after credential login. The chosen country drives currency,
// timezone, date format, locale, and the regulator/threshold defaults that
// downstream modules read. Persisted via `useCountry()` (localStorage) so
// the rest of the flow + the app can resolve country context.
//
// Additive re-connection of the existing 4-step onboarding flow: the
// reverted login card hands off here (via the RequireOnboarding gate) so
// the login's own design stays untouched.

import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronRight, Landmark, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/store/auth';
import { useCountry, useDomain, useTenantContext } from '@/lib/useOnboardingContext';
import { COUNTRIES, type CountryCode } from '@/lib/countries';
import { EnterpriseShell } from '../auth/EnterpriseShell';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';

export function OnboardingCountryPage() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const [country, setCountry] = useCountry();
  const [domain] = useDomain();
  const [tenantCtx] = useTenantContext();
  const [selected, setSelected] = useState<CountryCode | null>(country);

  // Not authenticated → back to login.
  if (!user) return <Navigate to="/login" replace />;
  // Already fully onboarded → home.
  if (country && domain && tenantCtx) return <Navigate to="/" replace />;

  const onConfirm = () => {
    if (!selected) return;
    setCountry(selected);
    navigate('/onboarding/domain', { replace: true });
  };

  return (
    <EnterpriseShell
      step={{ current: 1, total: 4, label: 'Onboarding' }}
      tagline="Choose your country context"
    >
      <div>
        <div className="mb-7">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-ews-orange mb-2">
            Step 1 of 4
          </p>
          <h2 className="font-display text-[28px] font-semibold text-ews-warmWhite tracking-tight leading-[1.1]">
            Select your country
          </h2>
          <p className="text-[13px] text-ews-warmWhite/70 mt-2 leading-relaxed">
            Country sets your currency, timezone, date format, and the banking + insurance
            regulator defaults ZorEWS applies. You can change it later from the user menu.
          </p>
          <p className="mt-3 font-mono text-[10.5px] text-ews-warmWhite/55">
            Signed in as <span className="text-ews-warmWhite font-medium">{user.username}</span>
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Country"
          className="grid grid-cols-1 gap-2 max-h-[340px] overflow-y-auto pr-1 sm:grid-cols-2"
        >
          {COUNTRIES.map((c) => (
            <button
              key={c.code}
              type="button"
              role="radio"
              aria-checked={selected === c.code}
              data-testid={`country-card-${c.code}`}
              onClick={() => setSelected(c.code)}
              className={cn(
                'group text-left rounded-card border transition-all p-3',
                'focus:outline-none focus:ring-2 focus:ring-ews-orange/40',
                selected === c.code
                  ? 'border-ews-orange bg-white/[0.08] shadow-[0_6px_20px_-10px_rgba(255,107,53,0.45)]'
                  : 'border-white/12 bg-white/[0.04] hover:border-ews-orange/60 hover:bg-white/[0.08]',
              )}
            >
              <div className="flex items-start gap-3">
                <span className="text-[26px] leading-none shrink-0" aria-hidden>
                  {c.flag}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-display text-[15px] font-semibold text-ews-warmWhite leading-tight truncate">
                      {c.name}
                    </p>
                    {selected === c.code && (
                      <CheckCircle2 size={16} className="text-ews-orange shrink-0" strokeWidth={2} />
                    )}
                  </div>
                  <p className="font-mono text-[10px] text-ews-warmWhite/55 mt-0.5">
                    {c.currency.symbol} {c.currency.code} · {c.timezone.label} · {c.date_format}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <CtxChip icon={<Landmark size={9} />} label={c.regulators.banking[0] ?? '—'} />
                    <CtxChip icon={<ShieldCheck size={9} />} label={c.regulators.insurance[0] ?? '—'} />
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="mt-7 flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="text-[12.5px] text-ews-warmWhite/55 hover:text-ews-warmWhite underline underline-offset-2"
          >
            ← Sign out
          </button>
          <Button
            type="button"
            data-testid="onboarding-country-confirm"
            disabled={!selected}
            onClick={onConfirm}
            className={cn(
              'min-w-[180px] font-semibold tracking-wide',
              '!bg-ews-orange hover:!bg-ews-orangeDeep !text-white !border-ews-orangeDeep',
              !selected && '!opacity-50 cursor-not-allowed',
            )}
          >
            Continue
            <ChevronRight size={16} className="ml-1 -mr-1" />
          </Button>
        </div>
      </div>
    </EnterpriseShell>
  );
}

function CtxChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-ews-warmWhite/70">
      <span className="text-ews-orange">{icon}</span>
      {label}
    </span>
  );
}
