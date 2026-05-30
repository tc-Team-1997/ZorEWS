// web/src/modules/ai/governance/AiGovernanceReportsPage.tsx
//
// AI Governance → AI Governance Reports.
//
// Curated catalog of 6 pre-templated regulator-facing AI governance
// packs. Each pack composes the existing M7.x model registry + M7.5
// performance ledger + drift fleet + M9.3 promotion ledger + M15.1
// audit chain. Click → land in the right governance sub-page with the
// model + metric pre-filtered.
//
// Same pattern as AuditComplianceReportsPage (audit-and-recovery-centers).
// Zero new BFF route — packs are a curated index, not a new aggregator.

import { Link, Navigate } from 'react-router-dom';
import {
  Shield,
  FileBadge,
  Microscope,
  Activity,
  TrendingUp,
  Gauge,
  Download,
  ExternalLink,
} from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

type PackTone = 'blue' | 'success' | 'warning' | 'neutral';

interface AiGovernancePack {
  id:
    | 'rbi-mrm-model-inventory'
    | 'rbi-mrm-validation-attestation'
    | 'irdai-explainability-signoff'
    | 'soc2-ml-change-control'
    | 'mrm-quarterly-review'
    | 'drift-retraining-attestation';
  label: string;
  regulator: 'RBI' | 'IRDAI' | 'SOC 2' | 'Internal MRM';
  cadence: 'quarterly' | 'monthly' | 'annual' | 'on-demand';
  description: string;
  primarySource: string;
  primaryTo: string;
  secondaryTo: string | null;
  icon: LucideIcon;
  tone: PackTone;
}

const AI_GOVERNANCE_PACKS: readonly AiGovernancePack[] = [
  {
    id: 'rbi-mrm-model-inventory',
    label: 'RBI MRM — Model Inventory',
    regulator: 'RBI',
    cadence: 'quarterly',
    description: 'RBI Model Risk Management §4.1 inventory: every model, version, status, framework, last-trained, last-deployed, deployment age + status badge.',
    primarySource: 'M7.1 registry + M7.11 deployment-age + M7.18 freshness.',
    primaryTo: '/ai/governance/monitoring',
    secondaryTo: '/audit-center/export',
    icon: Gauge,
    tone: 'blue',
  },
  {
    id: 'rbi-mrm-validation-attestation',
    label: 'RBI MRM — Validation Attestation',
    regulator: 'RBI',
    cadence: 'quarterly',
    description: 'Per-model validation evidence: AUC / KS / Brier on holdout, training rows, evaluator, sign-off via maker-checker. Pulls latest performance entry per model.',
    primarySource: 'M7.5 performance ledger + M9.3 maker-checker decisions.',
    primaryTo: '/ai/governance/performance',
    secondaryTo: '/ai/registry',
    icon: Shield,
    tone: 'success',
  },
  {
    id: 'irdai-explainability-signoff',
    label: 'IRDAI — Explainability Sign-off',
    regulator: 'IRDAI',
    cadence: 'on-demand',
    description: 'Per-decision SHAP + trust-signal evidence for IRDAI Form-K claim-fraud-investigation packets. Pulls per-prediction explanation for a given customer + window.',
    primarySource: 'Explanation API per prediction_id + trust-signal endpoint.',
    primaryTo: '/ai/workbench/explainability',
    secondaryTo: '/ai/governance/prediction-audit',
    icon: Microscope,
    tone: 'warning',
  },
  {
    id: 'soc2-ml-change-control',
    label: 'SOC 2 CC8.1 — ML Change Control',
    regulator: 'SOC 2',
    cadence: 'quarterly',
    description: 'Every model promotion + rollback + retire decision over the observation window, with maker, checker, and audit-chain anchor.',
    primarySource: 'M7.2 promotion ledger + M15.1 audit chain filtered to resource_type=model.',
    primaryTo: '/audit-center/export',
    secondaryTo: null,
    icon: FileBadge,
    tone: 'neutral',
  },
  {
    id: 'mrm-quarterly-review',
    label: 'Internal MRM — Quarterly Risk Review',
    regulator: 'Internal MRM',
    cadence: 'quarterly',
    description: 'Composite quarterly risk pack: monitoring health, drift verdicts, performance trend slope, retirement candidates, retraining-due list.',
    primarySource: 'Composes monitoring + drift + performance + freshness.',
    primaryTo: '/ai/governance/monitoring',
    secondaryTo: '/ai/governance/drift',
    icon: TrendingUp,
    tone: 'blue',
  },
  {
    id: 'drift-retraining-attestation',
    label: 'Drift + Retraining Attestation',
    regulator: 'Internal MRM',
    cadence: 'monthly',
    description: 'Every model with verdict ∈ {amber, red} this month + the retraining ticket / decision that closed (or deferred) the alert. Sign-off via maker-checker.',
    primarySource: 'Drift fleet + retraining schedule (T5.1.1) + M9.3 sensitive-action approvals.',
    primaryTo: '/ai/governance/drift',
    secondaryTo: '/audit-center/compliance',
    icon: Activity,
    tone: 'warning',
  },
] as const;

export function AiGovernanceReportsPage() {
  const me = useAuth((s) => s.user);

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor' || r === 'risk_analyst')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="ai-governance-reports-page">
      <PageHeader
        title="AI Governance Reports"
        subtitle="Pre-templated regulator-facing model risk packs — composes existing M7.x + M9.3 + M15.1 primitives."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <FileBadge size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">Curated index — zero duplicate machinery.</div>
            <p className="text-muted text-xs mt-0.5">
              Each pack composes existing model registry + performance ledger + drift fleet +
              promotion ledger + audit chain primitives. Click a pack → land in the right
              governance sub-page; secondary link opens the matching audit-export for evidence
              extraction.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="ai-governance-packs">
        {AI_GOVERNANCE_PACKS.map((pack) => {
          const Icon = pack.icon;
          return (
            <Panel key={pack.id} className="h-full" data-testid={`ai-governance-pack-${pack.id}`}>
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
                  <Icon size={18} className="text-aurora-indigo" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-display text-[15px] font-semibold text-ink">{pack.label}</h3>
                  <div className="mt-1 flex items-center gap-2 text-[11px]">
                    <Badge tone={pack.tone}>{pack.regulator}</Badge>
                    <Badge tone="neutral">{pack.cadence}</Badge>
                  </div>
                  <p className="text-[12px] text-muted mt-2 leading-snug">{pack.description}</p>
                  <p className="text-[11px] text-muted mt-2 italic">
                    <span className="font-medium text-ink">Source:</span> {pack.primarySource}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link to={pack.primaryTo} data-testid={`ai-governance-primary-${pack.id}`}>
                      <Button size="sm" variant="secondary">
                        <Download size={14} className="mr-1" /> Open primary view
                      </Button>
                    </Link>
                    {pack.secondaryTo && (
                      <Link to={pack.secondaryTo} data-testid={`ai-governance-secondary-${pack.id}`}>
                        <Button size="sm" variant="ghost">
                          <ExternalLink size={14} className="mr-1" /> Evidence pack
                        </Button>
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel className="mt-4" title="Adding a new governance pack">
        <p className="caption">
          New regulator templates ship as additive entries in
          {' '}<code>AI_GOVERNANCE_PACKS</code> — no BFF change, no schema migration, no SPA
          rebuild beyond importing the new icon. If a pack genuinely needs new aggregation,
          add a pure resolver under <code>services/bff/src/ai_*</code> following the M7.x
          naming pattern.
        </p>
      </Panel>
    </div>
  );
}

export { AI_GOVERNANCE_PACKS };
