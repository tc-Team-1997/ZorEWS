// STEP 2 — Domain Selection.
//
// After login the user lands here to pick Banking or Insurance. The
// choice is persisted via `useDomain()` (which wraps the existing
// `useVerticalMode` storage) so the rest of the SPA can switch its
// indicator catalogue, dashboards, and route gating accordingly.

import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Banknote,
  Briefcase,
  CheckCircle2,
  ChevronRight,
  Sparkles,
  LineChart,
} from 'lucide-react';
import { useAuth } from '@/store/auth';
import { useDomain, useCountry, useTenantContext } from '@/lib/useOnboardingContext';
import { EnterpriseShell } from '../auth/EnterpriseShell';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { getCountry } from '@/lib/countries';

type DomainChoice = 'banking' | 'insurance';

interface DomainCard {
  id: DomainChoice;
  icon: typeof Banknote;
  title: string;
  tagline: string;
  description: string;
  modules: string[];
  ai_features: string[];
  analytics_features: string[];
}

const CARDS: DomainCard[] = [
  {
    id: 'banking',
    icon: Banknote,
    title: 'Banking',
    tagline: 'Borrower stress · Fraud · Portfolio health',
    description:
      'Monitor borrower behaviour, SMA/NPA risk, fraud signals, and portfolio health using AI-powered Early Warning indicators.',
    modules: [
      'CBS loan + repayment ingest',
      'IFRS 9 stage migration (1 → 2 → 3)',
      'AML watchlist correlation',
      'Bureau pull (CIBIL / CRIF / Experian)',
      'Case management with maker-checker',
      'Collection routing + status callback',
    ],
    ai_features: [
      'PD scoring with SHAP top-5 reason codes',
      'Fraud-suspicion family (4 indicators)',
      'Drift monitoring + auto-promotion gate',
      'NL→SQL Copilot (stub) over mart.*',
    ],
    analytics_features: [
      'SMA / NPA classification dashboard',
      'Stage-migration matrix · 3 × 3',
      'Risk-trend over rolling 12 weeks',
      'PD distribution by product · segment',
    ],
  },
  {
    id: 'insurance',
    icon: Briefcase,
    title: 'Insurance',
    tagline: 'Claim fraud · Lapse · Underwriting anomaly',
    description:
      'Detect claim fraud, policy risk, customer churn, underwriting anomalies, and premium-collection issues using intelligent risk analytics.',
    modules: [
      'Core Insurance / Policy Master ingest',
      'Claims feed + abnormal pattern detection',
      'Agent productivity + persistency',
      'Solvency II + IFRS 17 stage signals',
      'Maker-checker on sensitive claim actions',
      'STR / regulatory reports (IRDAI Form-K)',
    ],
    ai_features: [
      'Claim fraud + lapse + churn models',
      'Anomaly detection on premium flow',
      'Repeat-claim window scoring',
      'Hospital flagging + watchlist join',
    ],
    analytics_features: [
      'Claims dashboard (4 abnormal patterns)',
      'Underwriting risk + decision latency',
      'Agent risk leaderboard + clusters',
      'Operational ops dashboard',
    ],
  },
];

export function OnboardingDomainPage() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const [country] = useCountry();
  const [domain, setDomain] = useDomain();
  const [tenantCtx] = useTenantContext();
  const [selected, setSelected] = useState<DomainChoice | null>(domain);

  // If the user dropped onto this page without authenticating, kick them back.
  if (!user) return <Navigate to="/login" replace />;
  // Already past STEP 3 → go home.
  if (domain && tenantCtx) return <Navigate to="/" replace />;

  const onConfirm = () => {
    if (!selected) return;
    setDomain(selected);
    navigate('/onboarding/tenant', { replace: true });
  };

  const countryDef = getCountry(country);

  return (
    <EnterpriseShell
      step={{ current: 2, total: 4, label: 'Onboarding' }}
      tagline="Choose your operating domain"
    >
      <div>
        <div className="mb-7">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-ews-orange mb-2">
            Step 2 of 4
          </p>
          <h2 className="font-display text-[28px] font-semibold text-ews-warmWhite tracking-tight leading-[1.1]">
            Pick your domain
          </h2>
          <p className="text-[13px] text-ews-warmWhite/70 mt-2 leading-relaxed">
            ZorEWS routes indicators, models, and dashboards based on whether you run a banking
            book or an insurance book. You can switch later from the user menu.
          </p>
          {countryDef && (
            <p className="mt-3 font-mono text-[10.5px] text-ews-warmWhite/55">
              Signed in as <span className="text-ews-warmWhite font-medium">{user.username}</span>
              <span className="text-ews-warmWhite/55/70"> · </span>
              {countryDef.flag} <span className="text-ews-warmWhite/80">{countryDef.name}</span>
            </p>
          )}
        </div>

        <div className="space-y-3.5">
          {CARDS.map((card) => (
            <DomainCardButton
              key={card.id}
              card={card}
              selected={selected === card.id}
              onClick={() => setSelected(card.id)}
            />
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
            data-testid="onboarding-domain-confirm"
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

interface DomainCardProps {
  card: DomainCard;
  selected: boolean;
  onClick: () => void;
}

function DomainCardButton({ card, selected, onClick }: DomainCardProps) {
  const Icon = card.icon;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={`domain-card-${card.id}`}
      onClick={onClick}
      className={cn(
        'group w-full text-left rounded-card border transition-all p-4',
        'focus:outline-none focus:ring-2 focus:ring-ews-orange/40',
        selected
          ? 'border-ews-orange bg-white/[0.08] shadow-[0_8px_24px_-12px_rgba(255,107,53,0.45)]'
          : 'border-white/12 bg-white/[0.04] hover:border-ews-orange/60 hover:bg-white/[0.08]',
      )}
    >
      <div className="flex items-start gap-3.5">
        <div
          className={cn(
            'shrink-0 h-11 w-11 rounded-md flex items-center justify-center transition-colors',
            selected
              ? 'bg-ews-orange text-white'
              : 'bg-ews-orange/10 text-ews-orange border border-white/12 group-hover:bg-ews-orange/15',
          )}
        >
          <Icon size={20} strokeWidth={1.75} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <p className="font-display text-[20px] font-semibold text-ews-warmWhite leading-tight">
              {card.title}
            </p>
            {selected && (
              <CheckCircle2 size={18} className="text-ews-orange shrink-0" strokeWidth={2} />
            )}
          </div>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ews-orange mt-0.5">
            {card.tagline}
          </p>
          <p className="text-[12.5px] text-ews-warmWhite/70 leading-relaxed mt-2">{card.description}</p>

          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <CardSection
              icon={<Briefcase size={11} />}
              label="Modules"
              items={card.modules.slice(0, 3)}
              tone={selected ? 'active' : 'idle'}
            />
            <CardSection
              icon={<Sparkles size={11} />}
              label="AI features"
              items={card.ai_features.slice(0, 3)}
              tone={selected ? 'active' : 'idle'}
            />
            <CardSection
              icon={<LineChart size={11} />}
              label="Analytics"
              items={card.analytics_features.slice(0, 3)}
              tone={selected ? 'active' : 'idle'}
            />
          </div>
        </div>
      </div>
    </button>
  );
}

interface CardSectionProps {
  icon: React.ReactNode;
  label: string;
  items: string[];
  tone: 'active' | 'idle';
}

function CardSection({ icon, label, items, tone }: CardSectionProps) {
  return (
    <div
      className={cn(
        'rounded border p-2',
        tone === 'active'
          ? 'border-ews-orange/30 bg-ews-orange/[0.04]'
          : 'border-white/10 bg-white/[0.03]',
      )}
    >
      <p className="flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-ews-warmWhite/55 mb-1.5">
        <span className={tone === 'active' ? 'text-ews-orange' : 'text-ews-warmWhite/55'}>{icon}</span>
        {label}
      </p>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <li key={it} className="text-[10.5px] text-ews-warmWhite/85 leading-snug">
            · {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
