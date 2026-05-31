// web/src/modules/admin/governance/RiskAndAlertGovernancePage.tsx
//
// Governance Center → Risk + Alert Governance (both sections share the
// severity-level master, so they ship as a paired index page with
// deep-links to the existing CRUD surfaces).

import { Link, Navigate } from 'react-router-dom';
import { AlertTriangle, Bell, Palette, Gauge, ArrowRight } from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

interface SubCard {
  id: string;
  label: string;
  description: string;
  to: string;
  icon: LucideIcon;
  tone?: 'blue' | 'success' | 'warning' | 'danger' | 'neutral';
}

const RISK_CARDS: readonly SubCard[] = [
  { id: 'risk-categories', label: 'Risk Categories', description: 'Credit / operational / fraud / compliance / collection / claim / underwriting. Edit at T11 master CRUD.', to: '/admin/masters/risk-categories', icon: AlertTriangle, tone: 'danger' },
  { id: 'severity-levels', label: 'Severity Levels', description: 'Low / medium / high / critical with colour mapping + weightage + risk-scoring metadata.', to: '/admin/masters/severity-levels', icon: Palette, tone: 'warning' },
  { id: 'risk-score-config', label: 'Risk Score Config', description: 'Indicator weight overrides + scoring presets (T6 M6.3).', to: '/admin/risk-score-config', icon: Gauge, tone: 'blue' },
];

const ALERT_CARDS: readonly SubCard[] = [
  { id: 'alert-classification', label: 'Alert Classification', description: 'BIL Red / Orange / Yellow / Green palette + per-class SLA + escalation path.', to: '/admin/alert-classification', icon: Bell, tone: 'warning' },
  { id: 'alert-categories', label: 'Alert Categories', description: 'Early-warning / Fraud / Collection / Compliance / Operational / Insurance buckets.', to: '/admin/masters/risk-categories', icon: AlertTriangle, tone: 'neutral' },
];

export function RiskAndAlertGovernancePage() {
  const me = useAuth((s) => s.user);
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="risk-alert-governance-page">
      <PageHeader
        title="Risk + Alert Governance"
        subtitle="Risk categories + severity levels feed the alert classification + per-class SLA + escalation pipeline."
      />

      <Panel className="mb-3" title="Risk masters">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="risk-cards">
          {RISK_CARDS.map((c) => (
            <SubCardLink key={c.id} card={c} testid={`risk-card-${c.id}`} />
          ))}
        </div>
      </Panel>

      <Panel title="Alert masters">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="alert-cards">
          {ALERT_CARDS.map((c) => (
            <SubCardLink key={c.id} card={c} testid={`alert-card-${c.id}`} />
          ))}
        </div>
      </Panel>

      <Panel className="mt-3">
        <p className="text-[11px] text-muted">
          Severity levels are the join key between Risk and Alert governance — a risk-category
          edit propagates to alert SLA buckets automatically because both reference the same
          T11 <code>severity-levels</code> master. Edits to either fan out to M15 audit chain.
        </p>
      </Panel>
    </div>
  );
}

function SubCardLink({ card, testid }: { card: SubCard; testid: string }) {
  const Icon = card.icon;
  return (
    <Link to={card.to} className="block group" data-testid={testid}>
      <Panel className="hover:border-action transition-colors h-full">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
            <Icon size={18} className="text-aurora-indigo" />
          </div>
          <div className="flex-1">
            <h3 className="font-display text-[14px] font-semibold text-ink flex items-center gap-2">
              {card.label}
              <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity text-action" />
            </h3>
            <p className="text-[11.5px] text-muted mt-0.5 leading-snug">{card.description}</p>
            {card.tone && <div className="mt-2"><Badge tone={card.tone}>{card.tone}</Badge></div>}
          </div>
        </div>
      </Panel>
    </Link>
  );
}

export { RISK_CARDS, ALERT_CARDS };
