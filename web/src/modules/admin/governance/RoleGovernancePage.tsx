// web/src/modules/admin/governance/RoleGovernancePage.tsx
//
// Governance Center → Role Governance.
//
// Centralised role management. The 10 platform roles + permission matrix
// already live at /admin/rbac (T6 enterprise layer); this page is the
// governance-tier index over that surface plus role-template clone +
// version history (which the future PermissionMatrix versioning feature
// will populate — for today, this page is the read-only inventory).

import { Link, Navigate } from 'react-router-dom';
import { Users, ShieldCheck, GitCompare, Crown, Briefcase, Eye, ArrowRight } from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

interface RoleTemplate {
  id: string;
  label: string;
  description: string;
  scope: 'platform' | 'country' | 'tenant';
  icon: LucideIcon;
}

const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { id: 'super_admin', label: 'Super Admin', description: 'Platform-wide governance + tenant onboarding + emergency overrides.', scope: 'platform', icon: Crown },
  { id: 'country_admin', label: 'Country Admin', description: 'Country-scoped tenant + branch + compliance rule mgmt.', scope: 'country', icon: ShieldCheck },
  { id: 'bank_admin', label: 'Bank Admin', description: 'Banking tenant root — users / roles / SLA / escalation / config.', scope: 'tenant', icon: Briefcase },
  { id: 'insurance_admin', label: 'Insurance Admin', description: 'Insurance tenant root — same scope as Bank Admin for insurer book.', scope: 'tenant', icon: Briefcase },
  { id: 'risk_analyst', label: 'Risk Analyst', description: 'Read + investigate alerts/cases, draft rules, propose model promotions.', scope: 'tenant', icon: Users },
  { id: 'fraud_analyst', label: 'Fraud Analyst', description: 'Fraud-specific workflows: claim-fraud checklist, anomaly investigation.', scope: 'tenant', icon: Users },
  { id: 'credit_officer', label: 'Credit Officer', description: 'Credit-side decision-making: case approval, restructuring proposals.', scope: 'tenant', icon: Users },
  { id: 'operations_user', label: 'Operations User', description: 'Day-to-day alert / case action, action logging, SLA tracking.', scope: 'tenant', icon: Users },
  { id: 'auditor', label: 'Auditor', description: 'Read-only across audit trail + compliance + governance change ledger.', scope: 'tenant', icon: Eye },
  { id: 'read_only_user', label: 'Read Only User', description: 'View-only access — dashboards + reports only, no mutations.', scope: 'tenant', icon: Eye },
];

export function RoleGovernancePage() {
  const me = useAuth((s) => s.user);
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="role-governance-page">
      <PageHeader
        title="Role Governance"
        subtitle="10 platform role templates with scope (platform / country / tenant). Permission matrix editor at /admin/rbac/permission-matrix."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <Users size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">Role templates + permission matrix + IAM Center are the 3 pillars.</div>
            <p className="text-muted text-xs mt-0.5">
              Role templates below define the canonical archetype. The T6 7-action × 25-module
              permission matrix at <Link to="/admin/rbac/permission-matrix" className="text-action underline">/admin/rbac/permission-matrix</Link>
              {' '}is the per-role × per-module grid editor. Per-user role assignments + access
              review live in the IAM Center.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="role-governance-templates">
        {ROLE_TEMPLATES.map((r) => {
          const Icon = r.icon;
          return (
            <Panel key={r.id} className="h-full" data-testid={`role-governance-template-${r.id}`}>
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
                  <Icon size={18} className="text-aurora-indigo" />
                </div>
                <div className="flex-1">
                  <h3 className="font-display text-[14px] font-semibold text-ink flex items-center gap-2">
                    {r.label}
                    <Badge tone={r.scope === 'platform' ? 'danger' : r.scope === 'country' ? 'warning' : 'blue'}>{r.scope}</Badge>
                  </h3>
                  <p className="text-[11.5px] text-muted mt-0.5 leading-snug">{r.description}</p>
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel className="mt-4" title="Permission matrix + comparison">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="role-governance-actions">
          <Link to="/admin/rbac/permission-matrix" className="block" data-testid="role-governance-link-matrix">
            <Panel className="hover:border-action transition-colors h-full">
              <div className="flex items-center gap-3">
                <ShieldCheck size={18} className="text-action" />
                <div className="flex-1">
                  <h4 className="font-medium text-ink flex items-center gap-2">Permission Matrix Editor <ArrowRight size={12} /></h4>
                  <p className="text-[11px] text-muted mt-0.5">Edit the 7-action × 25-module grid per role. Changes audit-logged.</p>
                </div>
              </div>
            </Panel>
          </Link>
          <Link to="/admin/iam/access-review" className="block" data-testid="role-governance-link-access-review">
            <Panel className="hover:border-action transition-colors h-full">
              <div className="flex items-center gap-3">
                <GitCompare size={18} className="text-action" />
                <div className="flex-1">
                  <h4 className="font-medium text-ink flex items-center gap-2">Per-user access review <ArrowRight size={12} /></h4>
                  <p className="text-[11px] text-muted mt-0.5">Drill into any user's effective role(s) + computed RBAC grid.</p>
                </div>
              </div>
            </Panel>
          </Link>
        </div>
      </Panel>
    </div>
  );
}

export { ROLE_TEMPLATES };
