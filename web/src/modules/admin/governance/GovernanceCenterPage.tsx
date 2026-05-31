// web/src/modules/admin/governance/GovernanceCenterPage.tsx
//
// Enterprise Governance Center landing page.
//
// Transforms the existing Master Setup into the single source of truth for
// every platform-governance dimension. 11 sub-sections layered ADDITIVELY
// over the existing Master Setup / Tenants / Branches / Compliance Rules /
// RBAC / IAM / Alert Classification / Escalation Matrix / SLA Config /
// Notification Templates surfaces. Same Rule Center / Audit Center / AI
// Governance / IAM Center pattern — zero existing API removed.

import { Link, Navigate } from 'react-router-dom';
import {
  Globe,
  Layers,
  Building2,
  Users,
  AlertTriangle,
  Bell,
  ArrowUpFromLine,
  Clock,
  Mail,
  Calendar,
  ShieldCheck,
  ArrowRight,
  Settings2,
} from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

interface GovernanceCard {
  id:
    | 'organization'
    | 'domain'
    | 'tenant'
    | 'role'
    | 'risk'
    | 'alert'
    | 'escalation'
    | 'sla'
    | 'notification'
    | 'calendar'
    | 'audit';
  label: string;
  description: string;
  to: string;
  legacyTo: string | null;
  icon: LucideIcon;
  tone: 'blue' | 'success' | 'warning' | 'danger' | 'neutral';
  reuses: string;
}

const GOVERNANCE_CARDS: readonly GovernanceCard[] = [
  {
    id: 'organization',
    label: 'Organization Governance',
    description: 'Countries · Regions · Branches · Departments — the org-chart substrate every other section joins to.',
    to: '/admin/governance/organization',
    legacyTo: '/admin/masters/countries',
    icon: Globe,
    tone: 'blue',
    reuses: 'T11 master_setup (countries / departments) + new regions master + /admin/governance/branches',
  },
  {
    id: 'domain',
    label: 'Domain Governance',
    description: 'Banking + Insurance enable/disable, domain ownership, configuration, metadata.',
    to: '/admin/governance/domains',
    legacyTo: null,
    icon: Layers,
    tone: 'success',
    reuses: 'DBAC resolver + tenant.vertical + per-tenant config (T6 M13.1 features.*)',
  },
  {
    id: 'tenant',
    label: 'Tenant Governance',
    description: 'Banking + Insurance tenant registry: HDFC / ICICI / SBI / ICICI Lombard / HDFC Ergo etc with admin + contact + status.',
    to: '/admin/tenants',
    legacyTo: '/admin/tenants',
    icon: Building2,
    tone: 'blue',
    reuses: 'AdminTenantsPage (existing)',
  },
  {
    id: 'role',
    label: 'Role Governance',
    description: 'Centralised role mgmt with templates, clone, version history, comparison. 10 platform roles + tenant role customisations.',
    to: '/admin/governance/roles',
    legacyTo: '/admin/rbac/permission-matrix',
    icon: Users,
    tone: 'warning',
    reuses: 'PermissionMatrixPage (T6) + IAM Center role views',
  },
  {
    id: 'risk',
    label: 'Risk Governance',
    description: 'Risk categories (credit / operational / fraud / compliance / collection / claim / underwriting) + severity levels with weightage + colour.',
    to: '/admin/governance/risk',
    legacyTo: '/admin/masters/risk-categories',
    icon: AlertTriangle,
    tone: 'danger',
    reuses: 'T11 master_setup (risk-categories + severity-levels)',
  },
  {
    id: 'alert',
    label: 'Alert Governance',
    description: 'Alert category catalogue: Early Warning / Fraud / Collection / Compliance / Operational / Insurance with SLA mapping.',
    to: '/admin/governance/alerts',
    legacyTo: '/admin/alert-classification',
    icon: Bell,
    tone: 'warning',
    reuses: 'AlertClassificationConfigPage + T11 master (severity-levels)',
  },
  {
    id: 'escalation',
    label: 'Escalation Governance',
    description: 'Escalation level matrix with priority / resolution time / owner / notification rules. Tenant + country specific overrides.',
    to: '/admin/escalation-matrix',
    legacyTo: '/admin/escalation-matrix',
    icon: ArrowUpFromLine,
    tone: 'warning',
    reuses: 'EscalationMatrixPage (existing)',
  },
  {
    id: 'sla',
    label: 'SLA Governance',
    description: 'Per-severity SLA policies (response + resolution time) with country / tenant / domain-specific overrides.',
    to: '/admin/sla-config',
    legacyTo: '/admin/sla-config',
    icon: Clock,
    tone: 'blue',
    reuses: 'SlaConfigPage (existing)',
  },
  {
    id: 'notification',
    label: 'Notification Governance',
    description: 'Email · SMS · in-app · webhook templates with version history, preview, test send, audit history.',
    to: '/admin/notification-templates',
    legacyTo: '/admin/notification-templates',
    icon: Mail,
    tone: 'success',
    reuses: 'NotificationTemplatesPage + M10.x catalog',
  },
  {
    id: 'calendar',
    label: 'Business Calendar',
    description: 'Working-days + holiday calendars per country / domain. Drives SLA + escalation business-day math.',
    to: '/admin/masters/business-calendars',
    legacyTo: null,
    icon: Calendar,
    tone: 'neutral',
    reuses: 'NEW T11 business-calendars master (auto-CRUD + audit via the framework)',
  },
  {
    id: 'audit',
    label: 'Governance Audit',
    description: 'Cross-section governance change ledger (regions / calendars / roles / domain config). Full audit trail + version comparison + restore.',
    to: '/audit-center/activity',
    legacyTo: '/audit-center',
    icon: ShieldCheck,
    tone: 'neutral',
    reuses: 'M15.1 audit chain + T11 master_audit + NEW governance_change_ledger',
  },
] as const;

export function GovernanceCenterPage() {
  const me = useAuth((s) => s.user);

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="governance-center-page">
      <PageHeader
        title="Enterprise Governance Center"
        subtitle="Single source of truth for platform governance — 11 sections layered over the existing Master Setup + Tenant + Branch + RBAC surface."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <Settings2 size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">Master Setup → Governance Center. Backward-compatible.</div>
            <p className="text-muted text-xs mt-0.5">
              Every legacy URL still works — /admin/master-setup, /admin/masters, /admin/tenants,
              /admin/sla-config, /admin/escalation-matrix, /admin/notification-templates,
              /admin/alert-classification, /admin/governance/branches. This page layers 11 governance
              sections on top, 2 net-new master entities (regions + business-calendars), and a
              cross-section change ledger feeding the M15 audit chain.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {GOVERNANCE_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.id}
              to={card.to}
              className="block group"
              data-testid={`governance-center-card-${card.id}`}
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

      <Panel className="mt-4" title="Backwards compatibility">
        <p className="caption">
          Every existing Master Setup / admin URL keeps resolving. The Governance Center is purely
          additive navigation that consolidates the 11 sections into one coherent tree. 2 new
          master entities (<code>regions</code> + <code>business-calendars</code>) are appended
          to the existing T11 registry so they pick up the same auto-CRUD + audit + permission
          gates the framework already provides.
        </p>
        <ul className="caption mt-2 space-y-0.5" data-testid="governance-center-legacy-links">
          {GOVERNANCE_CARDS.map((card) => (
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

export { GOVERNANCE_CARDS };
