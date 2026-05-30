// web/src/modules/ai/governance/AiGovernanceCenterPage.tsx
//
// Enterprise AI Governance Layer landing page.
//
// Consolidates the existing AI surfaces (AI Workbench / Model Registry /
// Explainability / Drift Detection / Experiment Tracking / AI Insights /
// Feature Store) plus 5 NEW governance landings into one tree under
// /ai/governance/*:
//
//   1. Model Monitoring Dashboard → AiModelMonitoringPage (NEW)
//   2. Prediction Audit Logs      → AiPredictionAuditPage (NEW)
//   3. Performance Tracking       → AiPerformanceTrackingPage (NEW)
//   4. Drift Monitoring Dashboard → AiDriftDashboardPage (NEW fleet view;
//                                    distinct from per-model /ai/drift)
//   5. Explainability Viewer      → wraps ExplainabilityPage (existing)
//   6. AI Governance Reports      → AiGovernanceReportsPage (NEW)
//
// Plus quick-links to the existing AI Workbench, Registry, Experiments,
// Insights, Feature Store + Drift Detection per-model deep-dive (all
// legacy URLs remain — additive navigation).

import { Link, Navigate } from 'react-router-dom';
import {
  Gauge,
  ListChecks,
  TrendingUp,
  Activity,
  Microscope,
  FileBadge,
  ArrowRight,
  Bot,
  Boxes,
  FlaskConical,
  BrainCircuit,
  Database,
  ShieldCheck,
} from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

interface AiGovernanceCard {
  id:
    | 'monitoring'
    | 'prediction-audit'
    | 'performance'
    | 'drift'
    | 'explainability'
    | 'reports';
  label: string;
  description: string;
  to: string;
  legacyTo: string | null;
  icon: LucideIcon;
  tone: 'blue' | 'success' | 'warning' | 'danger' | 'neutral';
  reuses: string;
}

const AI_GOVERNANCE_CARDS: readonly AiGovernanceCard[] = [
  {
    id: 'monitoring',
    label: 'Model Monitoring Dashboard',
    description: 'Fleet-wide health rollup: per-model status, deployment age, last performance metric, drift verdict, alert count.',
    to: '/ai/governance/monitoring',
    legacyTo: null,
    icon: Gauge,
    tone: 'blue',
    reuses: 'M7.1 registry + M7.11 deployment-age + M7.18 freshness',
  },
  {
    id: 'prediction-audit',
    label: 'Prediction Audit Logs',
    description: 'Filter-driven prediction history across every model, customer, prediction type. Drill into per-prediction explanation + trust signals.',
    to: '/ai/governance/prediction-audit',
    legacyTo: null,
    icon: ListChecks,
    tone: 'neutral',
    reuses: 'GET /v1/ai/predictions (filter-aware) + /:id/explanation',
  },
  {
    id: 'performance',
    label: 'Model Performance Tracking',
    description: 'Per-model + per-metric trend lines (AUC / precision / recall / F1 / drift_score). Slope-based regression detector + outlier flags.',
    to: '/ai/governance/performance',
    legacyTo: null,
    icon: TrendingUp,
    tone: 'success',
    reuses: 'M7.5 ledger + M7.7 outliers + M7.8 trend',
  },
  {
    id: 'drift',
    label: 'Drift Monitoring Dashboard',
    description: 'Fleet drift rollup: highest PSI per model, KS prediction drift, performance-drift watchlist. Click a row → existing per-model drift drill-down.',
    to: '/ai/governance/drift',
    legacyTo: '/ai/drift',
    icon: Activity,
    tone: 'warning',
    reuses: 'M7.6 drift fleet (T6 M7.6 / T2.6 monitor) + existing DriftMonitoringPage',
  },
  {
    id: 'explainability',
    label: 'Explainability Viewer',
    description: 'SHAP / feature-importance / trust-signal viewer per prediction. Moved under AI Workbench at /ai/workbench/explainability (legacy /ai/explainability still works).',
    to: '/ai/workbench/explainability',
    legacyTo: '/ai/explainability',
    icon: Microscope,
    tone: 'blue',
    reuses: 'ExplainabilityPage (existing)',
  },
  {
    id: 'reports',
    label: 'AI Governance Reports',
    description: 'Curated regulator-facing packs: model risk inventory (RBI), explainability sign-off (IRDAI), drift & retraining attestation, MRM quarterly review.',
    to: '/ai/governance/reports',
    legacyTo: null,
    icon: FileBadge,
    tone: 'success',
    reuses: 'Composes M7.x registry/perf/drift/promotions + M15.1 audit',
  },
] as const;

interface QuickLink {
  to: string;
  label: string;
  icon: LucideIcon;
}

const AI_QUICK_LINKS: readonly QuickLink[] = [
  { to: '/ai/workbench', label: 'AI Workbench', icon: Bot },
  { to: '/ai/registry', label: 'Model Registry', icon: Boxes },
  { to: '/ai/experiments', label: 'Experiment Tracking', icon: FlaskConical },
  { to: '/ai/insights', label: 'AI Insights', icon: BrainCircuit },
  { to: '/admin/feature-store', label: 'Feature Store', icon: Database },
];

export function AiGovernanceCenterPage() {
  const me = useAuth((s) => s.user);

  // Governance is an admin + supervisor + risk_analyst surface (matches the
  // existing AI Workbench role gate). Field officers stay out — governance
  // dashboards expose model risk + drift + perf which are MRM-tier views.
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor' || r === 'risk_analyst')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="ai-governance-center-page">
      <PageHeader
        title="AI Governance Center"
        subtitle="Single surface for monitoring, audit, performance, drift, explainability + regulator reports across every AI model."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <ShieldCheck size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">Enterprise AI governance, RBI / IRDAI MRM-aligned.</div>
            <p className="text-muted text-xs mt-0.5">
              Every existing AI URL still works. This page layers 5 new governance views over the
              existing AI Workbench / Registry / Drift / Insights / Feature Store + brings
              Explainability under the Workbench tree per RBI Model Risk Management §4 (model
              inventory, validation, monitoring + governance reporting).
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {AI_GOVERNANCE_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.id}
              to={card.to}
              className="block group"
              data-testid={`ai-governance-card-${card.id}`}
            >
              <Panel className="hover:border-action transition-colors h-full">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
                    <Icon size={18} className="text-aurora-indigo" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-display text-[15px] font-semibold text-ink flex items-center gap-2">
                      {card.label}
                      <ArrowRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity text-action" />
                    </h3>
                    <p className="text-[11.5px] text-muted mt-0.5 leading-snug">{card.description}</p>
                    <div className="mt-2 flex items-center gap-2 text-[11px]">
                      <Badge tone={card.tone}>reuses {card.reuses}</Badge>
                    </div>
                  </div>
                </div>
              </Panel>
            </Link>
          );
        })}
      </div>

      <Panel className="mt-4" title="AI Workbench quick links">
        <p className="caption mb-3">
          The non-governance AI surfaces (Workbench / Registry / Experiments / Insights /
          Feature Store) keep their existing URLs. Governance is a layered view on top — not
          a replacement.
        </p>
        <div className="flex flex-wrap gap-2" data-testid="ai-governance-quick-links">
          {AI_QUICK_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Link
                key={link.to}
                to={link.to}
                className="inline-flex items-center gap-1.5 rounded-md border border-aurora-line bg-white px-2.5 py-1 text-[12px] text-ink hover:border-action hover:text-action transition-colors"
                data-testid={`ai-governance-quick-${link.to.replace(/[^a-z]+/gi, '-')}`}
              >
                <Icon size={13} />
                {link.label}
              </Link>
            );
          })}
        </div>
      </Panel>

      <Panel className="mt-4" title="Backwards compatibility">
        <ul className="caption space-y-0.5" data-testid="ai-governance-legacy-links">
          {AI_GOVERNANCE_CARDS.map((card) => (
            <li key={card.id} className="text-xs">
              <span className="text-ink font-medium">{card.label}</span>:{' '}
              <Link to={card.to} className="text-action underline-offset-2 hover:underline">
                {card.to}
              </Link>
              {card.legacyTo && card.legacyTo !== card.to && (
                <>
                  {' '}↔{' '}
                  <Link to={card.legacyTo} className="text-muted underline-offset-2 hover:underline">
                    {card.legacyTo}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

export { AI_GOVERNANCE_CARDS, AI_QUICK_LINKS };
