// web/src/modules/admin/iam/UserLifecyclePage.tsx
//
// IAM Center → User Lifecycle (Feature 1).
//
// Status mgmt over the existing AdminUserRow surface. Reuses
// useAuth().adminListUsers + adds local lifecycle metadata (status badge,
// status history) via MSW-backed iam api wrappers. Bulk update toolbar
// kicks single requests in parallel until the BFF bulk endpoint lands.

import { Navigate } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserCog, History, AlertTriangle } from 'lucide-react';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, ALL_USER_LIFECYCLE_STATUSES, type UserLifecycleStatus, type UserStatusHistoryRow } from '@/lib/api';

const STATUS_TONE: Record<UserLifecycleStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'blue'> = {
  active: 'success',
  inactive: 'neutral',
  suspended: 'warning',
  locked: 'danger',
  pending_approval: 'blue',
};

export function UserLifecyclePage() {
  const me = useAuth((s) => s.user);
  const adminListUsers = useAuth((s) => s.adminListUsers);
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<UserLifecycleStatus>('inactive');
  const [bulkReason, setBulkReason] = useState('');
  const [historyUserId, setHistoryUserId] = useState<string | null>(null);

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  const usersQ = useQuery({ queryKey: ['admin.users'], queryFn: adminListUsers });
  const statusQ = useQuery({ queryKey: ['iam.user-statuses'], queryFn: () => api.iamUserStatuses() });
  const histQ = useQuery({
    queryKey: ['iam.status-history', historyUserId],
    queryFn: () => api.iamStatusHistory(historyUserId!),
    enabled: !!historyUserId,
  });

  const bulkMut = useMutation({
    mutationFn: () => api.iamBulkUpdateStatus({
      user_ids: [...selected],
      new_status: bulkStatus,
      reason: bulkReason || undefined,
    }),
    onSuccess: () => {
      setSelected(new Set());
      setBulkReason('');
      qc.invalidateQueries({ queryKey: ['iam.user-statuses'] });
    },
  });

  const statusByUser = useMemo(() => {
    const map = new Map<string, UserLifecycleStatus>();
    for (const row of statusQ.data?.items ?? []) map.set(row.user_id, row.status);
    return map;
  }, [statusQ.data]);

  const users = usersQ.data ?? [];
  const totals = useMemo(() => {
    const t: Record<UserLifecycleStatus, number> = {
      active: 0, inactive: 0, suspended: 0, locked: 0, pending_approval: 0,
    };
    for (const u of users) {
      const s = statusByUser.get(u.id) ?? (u.locked ? 'locked' : 'active');
      t[s] = (t[s] ?? 0) + 1;
    }
    return t;
  }, [users, statusByUser]);

  const allSelected = users.length > 0 && selected.size === users.length;

  return (
    <div data-testid="user-lifecycle-page">
      <PageHeader
        title="User Lifecycle"
        subtitle="Status management across active / inactive / suspended / locked / pending_approval, with history + bulk update."
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4" data-testid="user-lifecycle-kpis">
        {ALL_USER_LIFECYCLE_STATUSES.map((s) => (
          <MetricCard
            key={s}
            label={s.replace('_', ' ')}
            value={String(totals[s] ?? 0)}
            tone={
              s === 'locked' && totals[s] > 0 ? 'danger' :
              s === 'suspended' && totals[s] > 0 ? 'warning' :
              s === 'pending_approval' && totals[s] > 0 ? 'blue' :
              'neutral'
            }
            testId={`user-lifecycle-kpi-${s}`}
          />
        ))}
      </div>

      {selected.size > 0 && (
        <Panel className="mb-4" data-testid="user-lifecycle-bulk-toolbar">
          <div className="flex flex-wrap items-end gap-3">
            <div className="text-sm text-ink"><strong>{selected.size}</strong> user{selected.size === 1 ? '' : 's'} selected</div>
            <label className="text-xs text-muted">
              New status
              <select
                value={bulkStatus}
                onChange={(e) => setBulkStatus(e.target.value as UserLifecycleStatus)}
                className="input ml-2"
                data-testid="user-lifecycle-bulk-status"
              >
                {ALL_USER_LIFECYCLE_STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
              </select>
            </label>
            <input
              type="text"
              placeholder="Reason (≤ 2000 chars)"
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              className="input flex-1 min-w-[200px]"
              maxLength={2000}
              data-testid="user-lifecycle-bulk-reason"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={bulkMut.isPending}
              onClick={() => bulkMut.mutate()}
              data-testid="user-lifecycle-bulk-submit"
            >
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Cancel</Button>
          </div>
          {bulkMut.isError && (
            <p className="text-xs text-danger mt-2 flex items-center gap-1">
              <AlertTriangle size={12} /> {(bulkMut.error as Error)?.message ?? 'Bulk update failed'}
            </p>
          )}
          {bulkMut.isSuccess && (
            <p className="text-xs text-success mt-2">
              {bulkMut.data?.updated ?? 0} updated, {bulkMut.data?.failed?.length ?? 0} failed (correlation: <code>{bulkMut.data?.correlation_id}</code>)
            </p>
          )}
        </Panel>
      )}

      <Panel title={`${users.length} user${users.length === 1 ? '' : 's'}`}>
        {usersQ.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]" data-testid="user-lifecycle-table">
              <thead className="text-[11px] uppercase tracking-wide text-muted border-b border-divider">
                <tr>
                  <th className="text-left py-2 px-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(users.map((u) => u.id)))}
                      data-testid="user-lifecycle-select-all"
                    />
                  </th>
                  <th className="text-left py-2 px-2">User</th>
                  <th className="text-left py-2 px-2">Role</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const s: UserLifecycleStatus = statusByUser.get(u.id) ?? (u.locked ? 'locked' : 'active');
                  const isChecked = selected.has(u.id);
                  return (
                    <tr key={u.id} className="border-b border-divider/60 hover:bg-aurora-tint/30" data-testid={`user-lifecycle-row-${u.id}`}>
                      <td className="py-1.5 px-2">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(u.id); else next.delete(u.id);
                            setSelected(next);
                          }}
                          data-testid={`user-lifecycle-select-${u.id}`}
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <div className="font-medium text-ink">{u.display_name || u.username}</div>
                        <div className="text-[10.5px] text-muted">{u.username} · {u.email}</div>
                      </td>
                      <td className="py-1.5 px-2 text-ink">{u.role}</td>
                      <td className="py-1.5 px-2"><Badge tone={STATUS_TONE[s]}>{s.replace('_', ' ')}</Badge></td>
                      <td className="py-1.5 px-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-action hover:underline text-[11px]"
                          onClick={() => setHistoryUserId(u.id)}
                          data-testid={`user-lifecycle-history-${u.id}`}
                        >
                          <History size={11} /> History
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {historyUserId && (
        <Panel className="mt-4" title={`Status history — ${historyUserId}`} data-testid="user-lifecycle-history-panel">
          <div className="flex justify-end mb-2">
            <Button size="sm" variant="ghost" onClick={() => setHistoryUserId(null)}>Close</Button>
          </div>
          {histQ.isLoading ? <p className="text-sm text-muted">Loading…</p> : (
            <ul className="text-[12px] divide-y divide-divider">
              {(histQ.data?.items ?? []).map((h: UserStatusHistoryRow) => (
                <li key={h.history_id} className="py-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS_TONE[h.new_status]}>{h.new_status}</Badge>
                    <span className="text-muted text-[11px]">from {h.prev_status ?? '—'} by {h.changed_by} · {new Date(h.changed_at).toISOString().slice(0, 19).replace('T', ' ')}</span>
                  </div>
                  {h.reason && <div className="text-[11px] text-muted mt-1 italic">"{h.reason}"</div>}
                </li>
              ))}
              {(histQ.data?.items ?? []).length === 0 && <li className="py-2 text-muted text-[11px]">No history yet.</li>}
            </ul>
          )}
        </Panel>
      )}

      <Panel className="mt-4">
        <p className="text-[11px] text-muted flex items-center gap-1">
          <UserCog size={12} /> Status changes write to <code>app_iam.user_status_history</code> + fan out to the M15 audit hash-chain via the existing PgAuthAuditLog bridge.
        </p>
      </Panel>
    </div>
  );
}
