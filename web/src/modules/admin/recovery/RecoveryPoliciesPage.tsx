// web/src/modules/admin/recovery/RecoveryPoliciesPage.tsx
//
// Enterprise Recovery Management Center — per-tenant retention + auto-purge
// + maker-checker tunables per entity_type. The schema lands in migration
// 050_app_recovery.sql (app_recovery.recovery_policies); the SPA surface
// today shows the policy contract + default values so admins understand
// what's tunable before the BFF route lands in the follow-up.

import { Navigate } from 'react-router-dom';
import { Settings2, ShieldCheck } from 'lucide-react';
import { Badge, Panel, DataTable, type Column } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';

interface PolicyDefault {
  /** DataTable requires id — use entity_type as the natural key. */
  id: string;
  entity_type: string;
  retention_days: number;
  auto_purge_enabled: boolean;
  requires_maker_checker: boolean;
  min_checker_role: 'supervisor' | 'admin' | 'compliance_officer';
}

const DEFAULT_POLICIES: readonly PolicyDefault[] = [
  { id: 'tenant',        entity_type: 'tenant',         retention_days: 365,  auto_purge_enabled: false, requires_maker_checker: true,  min_checker_role: 'compliance_officer' },
  { id: 'customer',      entity_type: 'customer',       retention_days: 2555, auto_purge_enabled: false, requires_maker_checker: true,  min_checker_role: 'compliance_officer' },
  { id: 'case',          entity_type: 'case',           retention_days: 2555, auto_purge_enabled: false, requires_maker_checker: true,  min_checker_role: 'admin' },
  { id: 'investigation', entity_type: 'investigation',  retention_days: 2555, auto_purge_enabled: false, requires_maker_checker: true,  min_checker_role: 'admin' },
  { id: 'rule',          entity_type: 'rule',           retention_days: 730,  auto_purge_enabled: false, requires_maker_checker: true,  min_checker_role: 'admin' },
  { id: 'user',          entity_type: 'user',           retention_days: 365,  auto_purge_enabled: false, requires_maker_checker: true,  min_checker_role: 'admin' },
  { id: 'dashboard',     entity_type: 'dashboard',      retention_days: 90,   auto_purge_enabled: true,  requires_maker_checker: false, min_checker_role: 'supervisor' },
  { id: 'scenario',      entity_type: 'scenario',       retention_days: 180,  auto_purge_enabled: false, requires_maker_checker: true,  min_checker_role: 'supervisor' },
  { id: 'webhook',       entity_type: 'webhook',        retention_days: 90,   auto_purge_enabled: true,  requires_maker_checker: false, min_checker_role: 'supervisor' },
];

const COLUMNS: Column<PolicyDefault>[] = [
  {
    key: 'entity_type',
    header: 'Entity type',
    render: (row) => <code className="text-[12px]">{row.entity_type}</code>,
  },
  {
    key: 'retention_days',
    header: 'Retention',
    render: (row) => (
      <span className="text-[13px]">
        {row.retention_days >= 365
          ? `${Math.round(row.retention_days / 365)} years`
          : `${row.retention_days} days`}
      </span>
    ),
  },
  {
    key: 'auto_purge_enabled',
    header: 'Auto-purge',
    render: (row) => (
      <Badge tone={row.auto_purge_enabled ? 'warning' : 'neutral'}>
        {row.auto_purge_enabled ? 'enabled' : 'disabled'}
      </Badge>
    ),
  },
  {
    key: 'requires_maker_checker',
    header: 'Maker-checker',
    render: (row) => (
      <Badge tone={row.requires_maker_checker ? 'blue' : 'neutral'}>
        {row.requires_maker_checker ? 'required' : 'optional'}
      </Badge>
    ),
  },
  {
    key: 'min_checker_role',
    header: 'Min checker role',
    render: (row) => <code className="text-[12px]">{row.min_checker_role}</code>,
  },
];

export function RecoveryPoliciesPage() {
  const me = useAuth((s) => s.user);

  // Policy management is admin-only — these are tenant-wide retention knobs.
  if (me && !me.roles.some((r) => r === 'admin')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="recovery-policies-page">
      <PageHeader
        title="Recovery Policies"
        subtitle="Per-tenant retention windows, auto-purge cadence, and maker-checker requirements per entity type."
      />

      <Panel className="mb-4">
        <div className="flex items-start gap-3 text-sm text-ink">
          <Settings2 size={18} className="text-action shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Schema: <code>app_recovery.recovery_policies</code>.</div>
            <p className="text-muted text-xs mt-0.5">
              Per <code>(tenant_id, entity_type)</code> row carrying retention_days
              (1..2555 = 7 years), auto_purge_enabled, requires_maker_checker, and
              min_checker_role. The table below shows the platform defaults that
              apply when a tenant hasn't overridden — same source-of-truth pattern
              as <code>admin_config_catalog.ts</code> (M13.1).
            </p>
          </div>
        </div>
      </Panel>

      <Panel className="mb-4" title="Platform default policies">
        <div data-testid="recovery-policies-defaults-table">
          <DataTable
            columns={COLUMNS}
            data={DEFAULT_POLICIES}
            empty="No policies configured"
          />
        </div>
      </Panel>

      <Panel data-testid="recovery-policies-rbi-note">
        <div className="flex items-start gap-3 text-xs text-aurora-ink-sub">
          <ShieldCheck size={16} className="text-success shrink-0 mt-0.5" />
          <div>
            <strong className="text-aurora-ink">RBI alignment.</strong> Customer + case +
            investigation data retains for 7 years (2555 days) per the RBI banking
            records retention norm. Tenant + user retain for 1 year minimum. Auto-purge
            stays disabled on every high-value entity — purge always goes through
            maker-checker with min role <code>compliance_officer</code>.
          </div>
        </div>
      </Panel>
    </div>
  );
}
