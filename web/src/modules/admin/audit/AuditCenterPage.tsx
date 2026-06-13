// web/src/modules/admin/audit/AuditCenterPage.tsx
//
// Unified Audit Center landing page.
//
// Consolidates 3 scattered audit-adjacent surfaces (Audit Trail / Audit Log /
// Admin Activity / Admin Sessions) plus 2 NEW landings (Export Reports +
// Compliance Reports) into one navigation tree with 5 sub-sections:
//
//   1. Audit Trail        → wraps AuditTrailPage     (existing)
//   2. Login Audit        → wraps AdminSessionsPage  (existing)
//   3. Activity Logs      → wraps AuditLogPage + AdminActivityPage (?source=)
//   4. Export Reports     → AuditExportPage          (NEW)
//   5. Compliance Reports → AuditComplianceReportsPage (NEW)
//
// Zero-duplication design: every sub-route renders the existing component at
// a new URL. OLD routes (/admin/audit-trail, /admin/audit-log, /admin/activity,
// /admin/sessions) remain registered in App.tsx so bookmarks + tests keep
// working; the sidebar now exposes the unified /audit-center/* hierarchy.

import { Link, Navigate } from 'react-router-dom';
import {
  Shield,
  KeyRound,
  ScrollText,
  Download,
  FileBadge,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { ExportButton } from '@/components/export/ExportButton';
import { buildAuditCenterReportData } from './auditCenterReportAdapter';
import type { LucideIcon } from 'lucide-react';

interface AuditCenterCard {
  id: 'trail' | 'login-audit' | 'activity' | 'export' | 'compliance';
  label: string;
  description: string;
  to: string;
  /** Direct-link to the existing page when the user prefers the legacy URL. */
  legacyTo: string | null;
  icon: LucideIcon;
  tone: 'blue' | 'success' | 'warning' | 'neutral';
  /** Plain-English summary of which existing module backs this card. */
  reuses: string;
}

const AUDIT_CENTER_CARDS: readonly AuditCenterCard[] = [
  {
    id: 'trail',
    label: 'Audit Trail',
    description: 'M15 hash-chained regulatory ledger: every actor/action/resource/outcome with cryptographic provenance.',
    to: '/audit-center/trail',
    legacyTo: '/admin/audit-trail',
    icon: Shield,
    tone: 'blue',
    reuses: 'AuditTrailPage (M15 chain + CSV/PDF/XLSX export)',
  },
  {
    id: 'login-audit',
    label: 'Login Audit',
    description: 'Active sessions, login history, device + IP trail, revoke-any-session for admins.',
    to: '/audit-center/login-audit',
    legacyTo: '/admin/sessions',
    icon: KeyRound,
    tone: 'success',
    reuses: 'AdminSessionsPage',
  },
  {
    id: 'activity',
    label: 'Activity Logs',
    description: 'Operator activity stream: API calls, config touches, rule edits, alert acks. Toggle source via ?source=audit-log|admin-activity.',
    to: '/audit-center/activity',
    legacyTo: '/admin/audit-log',
    icon: ScrollText,
    tone: 'warning',
    reuses: 'AuditLogPage + AdminActivityPage',
  },
  {
    id: 'export',
    label: 'Export Reports',
    description: 'One-click bundle of audit events filtered by window + actor + resource type. CSV / PDF / XLSX with SHA-256 manifest.',
    to: '/audit-center/export',
    legacyTo: null,
    icon: Download,
    tone: 'neutral',
    reuses: 'AuditExportPage (NEW — wraps M15 export helpers)',
  },
  {
    id: 'compliance',
    label: 'Compliance Reports',
    description: 'Pre-templated regulator packs: RBI Cyber Resilience access review, IRDAI Form-K, SOC 2 evidence dump.',
    to: '/audit-center/compliance',
    legacyTo: null,
    icon: FileBadge,
    tone: 'blue',
    reuses: 'AuditComplianceReportsPage (NEW)',
  },
] as const;

export function AuditCenterPage() {
  const me = useAuth((s) => s.user);

  // Same role gate as the existing audit pages — admin + supervisor only.
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="audit-center-page">
      <PageHeader
        title="Audit Center"
        subtitle="Single surface for every regulatory + operational audit query across ZorEWS."
        actions={
          <ExportButton
            module="audit_center"
            reportType="compliance"
            adapter={(config) =>
              buildAuditCenterReportData(
                {
                  cards: AUDIT_CENTER_CARDS.map((c) => ({
                    id: c.id, label: c.label, description: c.description, to: c.to,
                  })),
                  meta: { tenant_id: 'BANK_DEMO', generated_by: me?.username ?? 'operator', role: me?.roles?.[0] ?? 'admin' },
                },
                config,
              )
            }
          />
        }
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <ShieldCheck size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">One place for the entire audit story.</div>
            <p className="text-muted text-xs mt-0.5">
              Every existing audit URL still works. This page collapses 4 scattered modules
              (Audit Trail / Audit Log / Admin Activity / Admin Sessions) into a single sidebar entry
              with 5 focused sub-sections — including 2 new landings (Export + Compliance Reports).
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {AUDIT_CENTER_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.id}
              to={card.to}
              className="block group"
              data-testid={`audit-center-card-${card.id}`}
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
          Every legacy URL still resolves to the same page — the unified Audit
          Center is purely additive navigation. If you have a bookmark to
          {' '}<code>/admin/audit-trail</code>, <code>/admin/audit-log</code>,
          {' '}<code>/admin/activity</code>, or <code>/admin/sessions</code>, nothing changes for you.
        </p>
        <ul className="caption mt-2 space-y-0.5" data-testid="audit-center-legacy-links">
          {AUDIT_CENTER_CARDS.map((card) => (
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

export { AUDIT_CENTER_CARDS };
