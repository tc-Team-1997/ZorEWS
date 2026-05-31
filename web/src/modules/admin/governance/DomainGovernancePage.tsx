// web/src/modules/admin/governance/DomainGovernancePage.tsx
//
// Governance Center → Domain Governance.
//
// Banking + Insurance enable/disable, ownership, configuration, metadata.
// Reuses DBAC resolver (services/bff/src/dbac/) + tenant.vertical + the
// existing M13.1 features.* toggles. Read-only summary view today; the
// per-tenant toggles already live in /admin/config — this page is the
// governance-level visibility.

import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Umbrella, Layers, ShieldCheck } from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api } from '@/lib/api';

interface DomainSummary {
  id: 'banking' | 'insurance';
  label: string;
  description: string;
  icon: typeof Landmark;
  capabilities: string[];
  tone: 'blue' | 'success';
}

const DOMAIN_CARDS: readonly DomainSummary[] = [
  {
    id: 'banking',
    label: 'Banking Domain',
    description: 'Loan / DPD / repayment / NPA / SMA classification + collections + bureau pull surfaces.',
    icon: Landmark,
    tone: 'blue',
    capabilities: [
      'Loan & DPD ingestion (CBS adapter)',
      'NPA + SMA-1/2/3 classification (RBI BAC-A)',
      'Collection routing + recovery analytics',
      'Bureau pull (CIBIL / CRIF / Experian / Equifax)',
      'IFRS-9 stage migration',
    ],
  },
  {
    id: 'insurance',
    label: 'Insurance Domain',
    description: 'Policy / claim / agent / underwriting / lapse-prediction surfaces under BIL §3-§14.',
    icon: Umbrella,
    tone: 'success',
    capabilities: [
      'Policy lifecycle + lapse prediction',
      'Claim fraud (BIL §17 8-step checklist)',
      'Agent productivity + risk contribution',
      'Underwriting deviation tracking',
      'IRDAI Form-K compliance pack',
    ],
  },
];

export function DomainGovernancePage() {
  const me = useAuth((s) => s.user);
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  const tenantsQ = useQuery({ queryKey: ['governance.tenants'], queryFn: () => api.tenantList() });

  const tenants = Array.isArray(tenantsQ.data) ? tenantsQ.data : (tenantsQ.data?.items ?? []);
  const byVertical = {
    banking: tenants.filter((t: { vertical?: string }) => t.vertical === 'banking'),
    insurance: tenants.filter((t: { vertical?: string }) => t.vertical === 'insurance'),
  };

  return (
    <div data-testid="domain-governance-page">
      <PageHeader
        title="Domain Governance"
        subtitle="Banking + Insurance domain inventory, ownership, capabilities. Per-tenant feature toggles live at /admin/config (features.*)."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <Layers size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">Multi-domain platform — banking + insurance run side-by-side.</div>
            <p className="text-muted text-xs mt-0.5">
              Each tenant is pinned to one vertical via <code>app_iam.tenants.vertical</code>;
              users inherit it via DBAC unless explicitly overridden on the user. The two domains
              share the underlying alert / case / RBAC / audit / IAM infrastructure.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="domain-governance-cards">
        {DOMAIN_CARDS.map((d) => {
          const Icon = d.icon;
          const tenantsForDomain = byVertical[d.id];
          return (
            <Panel key={d.id} className="h-full" data-testid={`domain-governance-card-${d.id}`}>
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
                  <Icon size={18} className="text-aurora-indigo" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-display text-[15px] font-semibold text-ink flex items-center gap-2">
                    {d.label}
                    <Badge tone={tenantsForDomain.length > 0 ? d.tone : 'neutral'}>
                      {tenantsForDomain.length} tenant{tenantsForDomain.length === 1 ? '' : 's'}
                    </Badge>
                  </h3>
                  <p className="text-[12px] text-muted mt-1 leading-snug">{d.description}</p>
                  <div className="mt-3">
                    <div className="text-[10.5px] uppercase tracking-wide text-muted mb-1">Capabilities</div>
                    <ul className="text-[11.5px] text-ink list-disc pl-4 space-y-0.5">
                      {d.capabilities.map((c) => <li key={c}>{c}</li>)}
                    </ul>
                  </div>
                  <div className="mt-3">
                    <div className="text-[10.5px] uppercase tracking-wide text-muted mb-1">Tenants</div>
                    {tenantsForDomain.length === 0 ? (
                      <p className="text-[11px] text-muted">None registered.</p>
                    ) : (
                      <ul className="text-[11.5px] text-ink space-y-0.5" data-testid={`domain-governance-tenants-${d.id}`}>
                        {tenantsForDomain.map((t: { tenant_id: string; name?: string }) => (
                          <li key={t.tenant_id} className="flex items-center justify-between">
                            <span>{t.name}</span>
                            <code className="text-[10px] text-muted">{t.tenant_id}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel className="mt-4">
        <p className="text-[11px] text-muted flex items-center gap-1">
          <ShieldCheck size={12} /> Per-tenant domain features (scenario_simulation / copilot /
          maker_checker) are managed at <code>/admin/config</code> under the <code>features</code>{' '}
          category. DBAC route guards at <code>/insurance/*</code> + the banking EWS pages enforce
          domain scope automatically.
        </p>
      </Panel>
    </div>
  );
}

export { DOMAIN_CARDS };
