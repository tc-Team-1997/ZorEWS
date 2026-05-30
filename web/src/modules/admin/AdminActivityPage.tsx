// Multi-source admin activity log — surfaces app_admin.admin_audit_log
// entries across user-access overrides (T6 §3.1.7), report exports
// (BAC §3.1.8), and EWS rule reverts (RP-1). The existing
// /admin/audit-log page only renders auth-svc events; this page is its
// counterpart for downstream admin actions.

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Filter, RefreshCw, Search } from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  downloadAdminActivityCsv,
  downloadAdminActivityPdf,
  downloadAdminActivityXlsx,
} from '@/lib/adminActivityExport';
import {
  api,
  type AdminAuditAction,
  type AdminAuditEntityType,
  type AdminAuditLogRow,
} from '@/lib/api';
import { useAuth, type AuthAuditEvent, type AuthEventType } from '@/store/auth';

const ENTITY_FILTERS: { value: '' | AdminAuditEntityType; label: string }[] = [
  { value: '', label: 'All sources' },
  { value: 'user_access_override', label: 'User access overrides' },
  { value: 'report_export', label: 'Report exports' },
  { value: 'ews_rule_version', label: 'EWS rule reverts' },
  // Phase 9 T1-full — auth-svc audit-event source
  { value: 'admin_user_action', label: 'Admin user actions' },
];

/** Phase 9 T1-full — map an auth-svc AuthEventType onto our AdminAuditAction
 *  vocabulary. Returns null when the event isn't an admin action (login,
 *  password-reset-request, etc. — those live on /admin/audit-log, NOT here). */
function authEventToAdminAction(t: AuthEventType): AdminAuditAction | null {
  switch (t) {
    case 'user_force_logout':
      return 'force_logout';
    case 'user_disabled':
      return 'disable';
    case 'user_enabled':
      return 'enable';
    case 'user_locked':
      return 'lock';
    case 'user_unlocked':
      return 'unlock';
    case 'user_created':
      return 'create';
    case 'user_deleted':
      return 'delete';
    case 'user_role_changed':
      return 'role_change';
    case 'admin_password_reset':
      return 'password_reset';
    default:
      return null;
  }
}

/** Phase 9 T1-full — adapt an AuthAuditEvent into the AdminAuditLogRow shape
 *  so the existing table renders it without per-source branching. Returns
 *  null when the event isn't an admin action. */
function adaptAuthEvent(ev: AuthAuditEvent): AdminAuditLogRow | null {
  const action = authEventToAdminAction(ev.type);
  if (!action) return null;
  return {
    audit_id: ev.id,
    tenant_id: (ev.metadata.tenant_id as string) ?? 'BANK_DEMO',
    entity_type: 'admin_user_action',
    entity_id: ev.target_username ?? '—',
    action,
    actor_id: ev.actor_username ?? 'system',
    actor_role: ev.actor_role ?? 'admin',
    before_state: null,
    after_state: { ...ev.metadata, event_type: ev.type, target_username: ev.target_username },
    reason: (ev.metadata.reason as string | undefined) ?? null,
    request_id: null,
    ip_address: ev.ip,
    user_agent: null,
    created_at: ev.ts,
  };
}

const ACTION_TONE: Record<AdminAuditAction, 'success' | 'warning' | 'danger' | 'neutral'> = {
  create: 'success',
  approve: 'success',
  update: 'neutral',
  reject: 'warning',
  revoke: 'danger',
  expire: 'warning',
  export: 'neutral',
  view: 'neutral',
  revert: 'warning',
  // Phase 9 T1-full — admin-action tones
  force_logout: 'danger',
  disable: 'danger',
  enable: 'success',
  lock: 'warning',
  unlock: 'success',
  delete: 'danger',
  role_change: 'warning',
  password_reset: 'neutral',
};

const ENTITY_LABEL: Record<AdminAuditEntityType, string> = {
  user_access_override: 'Override',
  report_export: 'Report',
  ews_rule_version: 'Rule',
  admin_user_action: 'User action',
};

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function summariseAfter(row: AdminAuditLogRow): string {
  if (!row.after_state || typeof row.after_state !== 'object') return '—';
  const a = row.after_state as Record<string, unknown>;
  // Each entity_type carries a different shape; show the most useful
  // 1-2 fields per type.
  if (row.entity_type === 'report_export') {
    return `${a.format ?? '?'} · ${a.rows ?? '?'} rows`;
  }
  if (row.entity_type === 'ews_rule_version') {
    return `${a.rule_id ?? '?'} → v${a.new_semver ?? '?'} (was v${a.reverted_to_semver ?? '?'})`;
  }
  if (row.entity_type === 'user_access_override') {
    const mp = (a.module_paths as unknown[] | undefined)?.join(', ');
    return `${a.user_id ?? '?'} · ${mp ?? a.module_path ?? '?'}`;
  }
  return '—';
}

export function AdminActivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const entityParam = searchParams.get('entity_type');
  const entityFilter: '' | AdminAuditEntityType = ENTITY_FILTERS.some(
    (f) => f.value === entityParam,
  )
    ? (entityParam as '' | AdminAuditEntityType)
    : '';

  const setEntity = (next: '' | AdminAuditEntityType) => {
    const sp = new URLSearchParams(searchParams);
    if (next === '') sp.delete('entity_type');
    else sp.set('entity_type', next);
    setSearchParams(sp, { replace: true });
  };

  const [actorQuery, setActorQuery] = useState('');
  const trimmedActor = actorQuery.trim();

  // Existing source — app_admin.admin_audit_log (UAO + report exports +
  // EWS rule reverts). Skip when the entityFilter pins to admin_user_action.
  const q = useQuery({
    queryKey: ['admin-activity', entityFilter, trimmedActor],
    queryFn: () =>
      api.uaoAuditLog({
        entity_type:
          entityFilter && entityFilter !== 'admin_user_action' ? entityFilter : undefined,
        actor_id: trimmedActor || undefined,
        page_size: 200,
      }),
    enabled: entityFilter !== 'admin_user_action',
  });

  // Phase 9 T1-full — auth-svc audit-event source. Fetched when filter is
  // 'admin_user_action' OR '' (the unified-timeline view).
  const adminAuditLog = useAuth((s) => s.adminAuditLog);
  const authQ = useQuery({
    queryKey: ['admin-activity-auth', trimmedActor],
    queryFn: () => adminAuditLog({ limit: 200 }),
    enabled: entityFilter === '' || entityFilter === 'admin_user_action',
  });

  const items = useMemo(() => {
    const uaoItems = q.data?.items ?? [];
    const authItemsRaw = authQ.data ?? [];
    // Adapt auth events to AdminAuditLogRow + drop non-admin actions.
    const authItems = authItemsRaw
      .map(adaptAuthEvent)
      .filter((r): r is AdminAuditLogRow => r !== null)
      .filter((r) => (trimmedActor ? r.actor_id === trimmedActor : true));
    // Filter to the requested source.
    let merged: AdminAuditLogRow[];
    if (entityFilter === 'admin_user_action') {
      merged = authItems;
    } else if (entityFilter === '') {
      merged = [...uaoItems, ...authItems];
    } else {
      merged = uaoItems;
    }
    // Sort newest-first by created_at; cap at 200 to match the existing
    // capped contract.
    return merged
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 200);
  }, [q.data, authQ.data, entityFilter, trimmedActor]);

  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of items) counts[r.entity_type] = (counts[r.entity_type] ?? 0) + 1;
    return counts;
  }, [items]);

  return (
    <div>
      <PageHeader
        title="Admin activity"
        subtitle="Cross-source admin audit log: overrides · report exports · rule reverts"
        actions={
          <div className="flex items-center gap-2" data-testid="admin-activity-export-row">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadAdminActivityCsv(items)}
              disabled={!items.length}
              data-testid="admin-activity-export-csv"
              title={
                items.length
                  ? `Export ${items.length} filtered entr${items.length === 1 ? 'y' : 'ies'} as CSV`
                  : 'No entries to export'
              }
            >
              <Download size={13} strokeWidth={2} /> CSV
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadAdminActivityPdf(items)}
              disabled={!items.length}
              data-testid="admin-activity-export-pdf"
              title={
                items.length
                  ? `Export ${items.length} filtered entr${items.length === 1 ? 'y' : 'ies'} as PDF`
                  : 'No entries to export'
              }
            >
              <Download size={13} strokeWidth={2} /> PDF
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void downloadAdminActivityXlsx(items);
              }}
              disabled={!items.length}
              data-testid="admin-activity-export-xlsx"
              title={
                items.length
                  ? `Export ${items.length} filtered entr${items.length === 1 ? 'y' : 'ies'} as Excel`
                  : 'No entries to export'
              }
            >
              <Download size={13} strokeWidth={2} /> Excel
            </Button>
          </div>
        }
      />

      <Panel
        title="Filters"
        className="mb-4"
        action={
          <Button
            type="button"
            variant="ghost"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw size={14} className="mr-1.5" />
            {q.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block">
            <span className="label">Source</span>
            <select
              className="input"
              value={entityFilter}
              onChange={(e) => setEntity(e.target.value as '' | AdminAuditEntityType)}
              data-testid="filter-entity-type"
            >
              {ENTITY_FILTERS.map((t) => (
                <option key={t.value || 'all'} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Actor</span>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="text"
                className="input pl-8"
                value={actorQuery}
                onChange={(e) => setActorQuery(e.target.value)}
                placeholder="filter by exact actor_id"
                data-testid="filter-actor"
              />
            </div>
          </label>
          <div className="flex items-end">
            <p className="caption">
              Showing <span className="font-mono">{items.length}</span> rows · UAO{' '}
              <span className="font-mono">{stats.user_access_override ?? 0}</span> · exports{' '}
              <span className="font-mono">{stats.report_export ?? 0}</span> · reverts{' '}
              <span className="font-mono">{stats.ews_rule_version ?? 0}</span> · user actions{' '}
              <span className="font-mono" data-testid="stat-admin-user-action">
                {stats.admin_user_action ?? 0}
              </span>
            </p>
          </div>
        </div>
      </Panel>

      <Panel
        title={`Activity (${items.length})`}
        action={
          <span className="caption">
            <Filter size={12} className="inline mr-1" />
            Newest first · capped at 200
          </span>
        }
      >
        {q.isLoading ? (
          <p className="py-6 text-center text-sm text-slate-500">Loading…</p>
        ) : q.isError ? (
          <p className="py-6 text-center text-sm text-rose-700" role="alert">
            {(q.error as Error)?.message ?? 'Failed to load activity log.'}
          </p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            No activity matches the filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="activity-table">
              <thead className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Time</th>
                  <th className="py-2 pr-3">Source</th>
                  <th className="py-2 pr-3">Action</th>
                  <th className="py-2 pr-3">Actor</th>
                  <th className="py-2 pr-3">Entity</th>
                  <th className="py-2 pr-3">Summary</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <ActivityRow key={row.audit_id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function ActivityRow({ row }: { row: AdminAuditLogRow }) {
  return (
    <tr
      className="border-b border-slate-100"
      data-testid={`activity-row-${row.audit_id}`}
      data-entity-type={row.entity_type}
    >
      <td className="py-2 pr-3 text-xs text-slate-500 tabular">{fmtTs(row.created_at)}</td>
      <td className="py-2 pr-3">
        <Badge tone="neutral">{ENTITY_LABEL[row.entity_type]}</Badge>
      </td>
      <td className="py-2 pr-3">
        <Badge tone={ACTION_TONE[row.action] ?? 'neutral'}>{row.action}</Badge>
      </td>
      <td className="py-2 pr-3 text-xs">
        <span className="font-medium">{row.actor_id}</span>
        <span className="text-slate-400"> ({row.actor_role})</span>
      </td>
      <td className="py-2 pr-3 font-mono text-[11px] text-slate-600">
        <EntityLink row={row} />
      </td>
      <td className="py-2 pr-3 text-xs text-slate-700">{summariseAfter(row)}</td>
    </tr>
  );
}

function EntityLink({ row }: { row: AdminAuditLogRow }) {
  // Deep-links per source so the auditor can jump to the entity in one click.
  if (row.entity_type === 'ews_rule_version') {
    const after = row.after_state as { rule_id?: string; reverted_to_semver?: string } | null;
    if (after?.rule_id && after?.reverted_to_semver) {
      return (
        <Link
          to={`/rules/ews/${encodeURIComponent(after.rule_id)}/diff?from=${encodeURIComponent(after.reverted_to_semver)}`}
          className="text-blue-600 hover:underline"
        >
          {after.rule_id}
        </Link>
      );
    }
  }
  if (row.entity_type === 'user_access_override') {
    return <Link to="/admin/user-access-override" className="text-blue-600 hover:underline">{row.entity_id.slice(0, 12)}…</Link>;
  }
  // Phase 9 T1-full — for admin user actions the entity_id is the
  // target_username; deep-link to /admin/sessions filtered to that user
  // (force-logout / disable / lock all touch sessions) for context.
  if (row.entity_type === 'admin_user_action') {
    return (
      <Link
        to="/admin/users"
        className="text-blue-600 hover:underline"
        title="Open Users admin"
      >
        {row.entity_id}
      </Link>
    );
  }
  return <span>{row.entity_id.slice(0, 12)}…</span>;
}
