// web/src/modules/admin/iam/IamCenterPage.tsx
//
// Enterprise IAM Center landing page — same pattern as Rule Center /
// Audit Center / AI Governance Center. Consolidates 6 IAM sub-sections
// into one tree under /admin/iam/*.
//
// Backwards-compat: every legacy URL still resolves
// (/admin/users, /admin/users/new, /admin/sessions).

import { Link, Navigate } from 'react-router-dom';
import {
  UserCog,
  Eye,
  ShieldCheck,
  ScrollText,
  KeyRound,
  Monitor,
  ArrowRight,
  Users,
} from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

interface IamCenterCard {
  id: 'lifecycle' | 'access-review' | 'approvals' | 'audit' | 'sessions' | 'password-policy';
  label: string;
  description: string;
  to: string;
  legacyTo: string | null;
  icon: LucideIcon;
  tone: 'blue' | 'success' | 'warning' | 'danger' | 'neutral';
  reuses: string;
}

const IAM_CENTER_CARDS: readonly IamCenterCard[] = [
  {
    id: 'lifecycle',
    label: 'User Lifecycle',
    description: 'Status mgmt (active/inactive/suspended/locked/pending_approval) + history + bulk update.',
    to: '/admin/iam/lifecycle',
    legacyTo: '/admin/users',
    icon: UserCog,
    tone: 'blue',
    reuses: 'IUserStore + new IUserLifecycleStore',
  },
  {
    id: 'access-review',
    label: 'Access Review',
    description: 'Per-user 360 panel: country, domain, tenant, branch, department, role(s) + RBAC summary across 7 actions.',
    to: '/admin/iam/access-review',
    legacyTo: '/admin/users',
    icon: Eye,
    tone: 'success',
    reuses: 'IUserStore + T6 permission_matrix + DBAC resolver',
  },
  {
    id: 'approvals',
    label: 'Approvals Inbox',
    description: 'Maker-checker queue for sensitive IAM actions. Pending → approved/rejected with mandatory comments + self-approval ban.',
    to: '/admin/iam/approvals',
    legacyTo: null,
    icon: ShieldCheck,
    tone: 'warning',
    reuses: 'NEW IUserApprovalStore — distinct from generic M9.3 maker-checker',
  },
  {
    id: 'audit',
    label: 'User Audit History',
    description: 'Per-user event timeline (created/updated/role-changed/access-changed/status-changed/password-reset) with before/after diff.',
    to: '/admin/iam/audit',
    legacyTo: '/audit-center/activity',
    icon: ScrollText,
    tone: 'neutral',
    reuses: 'NEW IUserAuditStore + M15 audit chain fan-out',
  },
  {
    id: 'sessions',
    label: 'Session Governance',
    description: 'Active sessions, last login/logout, browser/device/country/IP, force logout single + logout all, session history.',
    to: '/admin/sessions',
    legacyTo: '/admin/sessions',
    icon: Monitor,
    tone: 'blue',
    reuses: 'AdminSessionsPage (existing, enhanced with browser/device/country columns)',
  },
  {
    id: 'password-policy',
    label: 'Password Policy',
    description: 'Per-tenant password policy: min length, complexity, expiry days, lockout threshold, reminder window.',
    to: '/admin/iam/password-policy',
    legacyTo: null,
    icon: KeyRound,
    tone: 'success',
    reuses: 'NEW IPasswordGovernanceStore — composes with auth-svc IUserStore.setPassword',
  },
] as const;

export function IamCenterPage() {
  const me = useAuth((s) => s.user);

  // IAM Center is admin + supervisor (destructive ops are admin-only at the route layer).
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="iam-center-page">
      <PageHeader
        title="IAM Center"
        subtitle="Enterprise user lifecycle, password governance, session governance, access review, approvals & audit — one place for the whole identity story."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <Users size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">Layered IAM — additive over the existing User + Session + RBAC + DBAC + Tenant surface.</div>
            <p className="text-muted text-xs mt-0.5">
              Every legacy URL still works (/admin/users, /admin/users/new, /admin/sessions). This
              page consolidates 6 IAM sub-sections — 5 net-new + 1 enhanced — into one tree under
              /admin/iam/*. RBI / IRDAI / SOC 2 access-review aligned.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {IAM_CENTER_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.id}
              to={card.to}
              className="block group"
              data-testid={`iam-center-card-${card.id}`}
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
          The legacy AdminUsersPage at <code>/admin/users</code>, the create wizard at
          {' '}<code>/admin/users/new</code>, and the AdminSessionsPage at
          {' '}<code>/admin/sessions</code> all remain. This page adds 5 net-new IAM views on
          top — no removals.
        </p>
        <ul className="caption mt-2 space-y-0.5" data-testid="iam-center-legacy-links">
          {IAM_CENTER_CARDS.map((card) => (
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

export { IAM_CENTER_CARDS };
