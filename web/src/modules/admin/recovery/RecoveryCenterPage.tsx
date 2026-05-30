// web/src/modules/admin/recovery/RecoveryCenterPage.tsx
//
// Unified Recovery Center landing page.
//
// Consolidates 2 scattered recovery surfaces (Recycle Bin + Recovery Analytics)
// into one navigation tree with 4 sub-sections:
//
//   1. Deleted Records   → wraps RecycleBinPage          (existing, default)
//   2. Restore           → wraps RecycleBinPage (?status=deleted highlight)
//   3. Permanent Delete  → wraps RecycleBinPage (?status=deleted + danger banner)
//   4. Recovery Analytics→ wraps RecoveryAnalyticsPage   (existing)
//
// Zero-duplication: the RecycleBinPage already has both restore + permanent-
// delete buttons inline. The new sub-routes split the same surface by USER
// INTENT — admins land directly in the right context. OLD routes
// (/admin/recycle-bin, /admin/recovery-analytics) remain registered in
// App.tsx so bookmarks + tests keep working.

import { Link, Navigate } from 'react-router-dom';
import {
  Trash2,
  Undo2,
  ShieldAlert,
  BarChart3,
  ArrowRight,
  Archive,
} from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

interface RecoveryCenterCard {
  id: 'deleted' | 'restore' | 'permanent-delete' | 'analytics';
  label: string;
  description: string;
  to: string;
  legacyTo: string | null;
  icon: LucideIcon;
  tone: 'blue' | 'success' | 'warning' | 'danger' | 'neutral';
  reuses: string;
}

const RECOVERY_CENTER_CARDS: readonly RecoveryCenterCard[] = [
  {
    id: 'deleted',
    label: 'Deleted Records',
    description: 'Every soft-deleted row across the platform: tenants, users, rules, dashboards, scenarios. Filter by entity type + actor + window.',
    to: '/recovery-center/deleted',
    legacyTo: '/admin/recycle-bin',
    icon: Trash2,
    tone: 'blue',
    reuses: 'RecycleBinPage (default tab)',
  },
  {
    id: 'restore',
    label: 'Restore',
    description: 'Re-insert a deleted record back to its original table. 409 conflict raised if the original ID was recreated since deletion.',
    to: '/recovery-center/restore',
    legacyTo: '/admin/recycle-bin',
    icon: Undo2,
    tone: 'success',
    reuses: 'RecycleBinPage Restore action',
  },
  {
    id: 'permanent-delete',
    label: 'Permanent Delete',
    description: 'Irrecoverably purge a soft-deleted record. Requires admin role + audit-trailed; cannot be reversed once the row is gone.',
    to: '/recovery-center/permanent-delete',
    legacyTo: '/admin/recycle-bin',
    icon: ShieldAlert,
    tone: 'danger',
    reuses: 'RecycleBinPage Purge action',
  },
  {
    id: 'analytics',
    label: 'Recovery Analytics',
    description: 'Soft-delete rate, restore rate, purge rate, top-deleted entity types, deletes-by-actor leaderboard.',
    to: '/recovery-center/analytics',
    legacyTo: '/admin/recovery-analytics',
    icon: BarChart3,
    tone: 'neutral',
    reuses: 'RecoveryAnalyticsPage',
  },
] as const;

export function RecoveryCenterPage() {
  const me = useAuth((s) => s.user);

  // Recovery Center is admin-only — destructive actions live here.
  if (me && !me.roles.some((r) => r === 'admin')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="recovery-center-page">
      <PageHeader
        title="Recovery Center"
        subtitle="Audit, restore, or permanently purge soft-deleted records across every ZorEWS module."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <Archive size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">One place for the entire recovery lifecycle.</div>
            <p className="text-muted text-xs mt-0.5">
              Every existing recovery URL still works. This page surfaces the soft-delete /
              restore / purge / analytics flow as 4 focused sub-sections instead of one
              dense table — admins land directly in the right context per intent.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {RECOVERY_CENTER_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.id}
              to={card.to}
              className="block group"
              data-testid={`recovery-center-card-${card.id}`}
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
          Every legacy URL still resolves to the same page — the unified Recovery
          Center is purely additive navigation. <code>/admin/recycle-bin</code> +
          {' '}<code>/admin/recovery-analytics</code> still work for bookmarks + scripts.
        </p>
        <ul className="caption mt-2 space-y-0.5" data-testid="recovery-center-legacy-links">
          {RECOVERY_CENTER_CARDS.map((card) => (
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

export { RECOVERY_CENTER_CARDS };
