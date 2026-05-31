// web/src/modules/admin/iam/UserApprovalsInboxPage.tsx
//
// IAM Center → User Approvals Inbox (Feature 5).
//
// Maker-checker queue for sensitive IAM actions. Pending requests sorted
// oldest-first (FIFO); approve/reject with mandatory comments + self-
// approval guard (also enforced at DB level via CHECK constraint).

import { Navigate } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Check, X, AlertTriangle } from 'lucide-react';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, ALL_USER_APPROVAL_STATUSES, type UserApprovalStatus, type UserApprovalRecord } from '@/lib/api';

const TONE: Record<UserApprovalStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'blue'> = {
  pending: 'blue',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
  expired: 'warning',
};

export function UserApprovalsInboxPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [tab, setTab] = useState<UserApprovalStatus>('pending');
  const [selected, setSelected] = useState<UserApprovalRecord | null>(null);
  const [comments, setComments] = useState('');

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  const summaryQ = useQuery({ queryKey: ['iam.approvals.summary'], queryFn: () => api.iamApprovalsSummary() });
  const listQ = useQuery({
    queryKey: ['iam.approvals', tab],
    queryFn: () => api.iamApprovalsList({ status: tab }),
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => api.iamApprovalDecide(id, 'approve', comments || undefined),
    onSuccess: () => {
      setSelected(null);
      setComments('');
      qc.invalidateQueries({ queryKey: ['iam.approvals'] });
      qc.invalidateQueries({ queryKey: ['iam.approvals.summary'] });
    },
  });
  const rejectMut = useMutation({
    mutationFn: (id: string) => api.iamApprovalDecide(id, 'reject', comments),
    onSuccess: () => {
      setSelected(null);
      setComments('');
      qc.invalidateQueries({ queryKey: ['iam.approvals'] });
      qc.invalidateQueries({ queryKey: ['iam.approvals.summary'] });
    },
  });

  const rows = listQ.data?.items ?? [];
  const summary = summaryQ.data;
  const isSelfApproval = useMemo(() => selected && me && selected.requested_by === me.username, [selected, me]);

  return (
    <div data-testid="user-approvals-inbox-page">
      <PageHeader
        title="Approvals Inbox"
        subtitle="Maker-checker queue for sensitive IAM actions. Self-approval blocked at app + DB level."
      />

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4" data-testid="approvals-kpis">
          {ALL_USER_APPROVAL_STATUSES.map((s) => (
            <MetricCard
              key={s}
              label={s}
              value={String(summary.by_status[s] ?? 0)}
              tone={s === 'pending' ? 'blue' : s === 'rejected' ? 'danger' : 'neutral'}
              testId={`approvals-kpi-${s}`}
            />
          ))}
        </div>
      )}

      <Panel className="mb-3">
        <div className="flex gap-2" data-testid="approvals-tabs">
          {ALL_USER_APPROVAL_STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={tab === s ? 'secondary' : 'ghost'}
              onClick={() => setTab(s)}
              data-testid={`approvals-tab-${s}`}
            >
              {s}{summary ? ` (${summary.by_status[s] ?? 0})` : ''}
            </Button>
          ))}
        </div>
      </Panel>

      <Panel title={tab === 'pending' ? `${rows.length} pending — oldest first` : `${rows.length} ${tab}`}>
        {listQ.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted flex items-center gap-2"><ShieldCheck size={14} /> No approvals in this bucket.</p>
        ) : (
          <ul className="text-[12px] divide-y divide-divider" data-testid="approvals-list">
            {rows.map((r) => (
              <li key={r.approval_id} className="py-2 flex flex-wrap items-center justify-between gap-2" data-testid={`approvals-row-${r.approval_id}`}>
                <div>
                  <div className="font-medium text-ink">{r.action_type.replace(/_/g, ' ')}</div>
                  <div className="text-[11px] text-muted">
                    target: <code>{r.user_id}</code> · by <strong>{r.requested_by}</strong> · {new Date(r.requested_at).toISOString().slice(0, 19).replace('T', ' ')}
                  </div>
                  {r.request_comments && <div className="text-[11px] text-muted mt-1 italic">"{r.request_comments}"</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={TONE[r.status]}>{r.status}</Badge>
                  {r.status === 'pending' && (
                    <Button size="sm" variant="secondary" onClick={() => { setSelected(r); setComments(''); }} data-testid={`approvals-review-${r.approval_id}`}>
                      Review
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {selected && (
        <Panel className="mt-4" title={`Review approval ${selected.approval_id}`} data-testid="approvals-review-panel">
          <div className="space-y-3 text-[12px]">
            <div><strong>Action:</strong> {selected.action_type}</div>
            <div><strong>Target user:</strong> <code>{selected.user_id}</code></div>
            <div><strong>Requested by:</strong> {selected.requested_by}</div>
            {Object.keys(selected.payload).length > 0 && (
              <div>
                <strong>Payload:</strong>
                <pre className="bg-aurora-tint/30 p-2 rounded mt-1 text-[11px] overflow-x-auto" data-testid="approvals-payload">{JSON.stringify(selected.payload, null, 2)}</pre>
              </div>
            )}
            <label className="block">
              <span className="text-xs text-muted">Decision comments (required for reject)</span>
              <textarea
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                rows={3}
                maxLength={4000}
                className="input w-full"
                data-testid="approvals-comments"
              />
            </label>
            {isSelfApproval && (
              <p className="text-xs text-danger flex items-center gap-1"><AlertTriangle size={12} /> You requested this — self-approval is forbidden.</p>
            )}
            {(approveMut.isError || rejectMut.isError) && (
              <p className="text-xs text-danger">
                {((approveMut.error ?? rejectMut.error) as Error)?.message ?? 'Decision failed'}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setComments(''); }}>Cancel</Button>
              <Button
                size="sm"
                variant="danger"
                disabled={isSelfApproval || rejectMut.isPending || !comments.trim()}
                onClick={() => rejectMut.mutate(selected.approval_id)}
                data-testid="approvals-reject"
              >
                <X size={14} className="mr-1" /> Reject
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={isSelfApproval || approveMut.isPending}
                onClick={() => approveMut.mutate(selected.approval_id)}
                data-testid="approvals-approve"
              >
                <Check size={14} className="mr-1" /> Approve
              </Button>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
