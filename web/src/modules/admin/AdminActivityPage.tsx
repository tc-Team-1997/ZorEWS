// Multi-source admin activity log — surfaces app_admin.admin_audit_log
// entries across user-access overrides (T6 §3.1.7), report exports
// (BAC §3.1.8), and EWS rule reverts (RP-1). The existing
// /admin/audit-log page only renders auth-svc events; this page is its
// counterpart for downstream admin actions.

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Filter, RefreshCw, Search } from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  api,
  type AdminAuditAction,
  type AdminAuditEntityType,
  type AdminAuditLogRow,
} from '@/lib/api';

const ENTITY_FILTERS: { value: '' | AdminAuditEntityType; label: string }[] = [
  { value: '', label: 'All sources' },
  { value: 'user_access_override', label: 'User access overrides' },
  { value: 'report_export', label: 'Report exports' },
  { value: 'ews_rule_version', label: 'EWS rule reverts' },
];

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
};

const ENTITY_LABEL: Record<AdminAuditEntityType, string> = {
  user_access_override: 'Override',
  report_export: 'Report',
  ews_rule_version: 'Rule',
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

  const q = useQuery({
    queryKey: ['admin-activity', entityFilter, trimmedActor],
    queryFn: () =>
      api.uaoAuditLog({
        entity_type: entityFilter || undefined,
        actor_id: trimmedActor || undefined,
        page_size: 200,
      }),
  });

  const items = q.data?.items ?? [];
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
              <span className="font-mono">{stats.ews_rule_version ?? 0}</span>
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
  return <span>{row.entity_id.slice(0, 12)}…</span>;
}
