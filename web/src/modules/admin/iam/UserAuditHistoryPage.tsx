// web/src/modules/admin/iam/UserAuditHistoryPage.tsx
//
// IAM Center → User Audit History (Feature 6).
//
// Per-user event timeline with before/after JSON diff viewer. Filter by
// event_type + actor + date window. Composes the new IUserAuditStore
// surface. Source-of-truth fans out to M15 audit.event_log hash-chain
// via the existing PgAuthAuditLog + AuditEventLogClient bridge.

import { Navigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, Filter } from 'lucide-react';
import { Badge, Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, ALL_USER_AUDIT_EVENT_TYPES, type UserAuditEventType, type UserAuditHistoryRow } from '@/lib/api';

const TONE: Record<UserAuditEventType, 'success' | 'warning' | 'danger' | 'neutral' | 'blue'> = {
  user_created: 'success',
  user_updated: 'blue',
  password_reset: 'warning',
  role_changed: 'warning',
  access_changed: 'warning',
  status_changed: 'blue',
  approval_requested: 'neutral',
  approval_decided: 'success',
  session_terminated: 'neutral',
  profile_updated: 'neutral',
  lifecycle_bulk_update: 'blue',
};

export function UserAuditHistoryPage() {
  const me = useAuth((s) => s.user);
  const { username } = useParams<{ username?: string }>();
  const [eventFilter, setEventFilter] = useState<'' | UserAuditEventType>('');
  const [actor, setActor] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  const q = useQuery({
    queryKey: ['iam.audit-history', username, eventFilter, actor],
    queryFn: () => username
      ? api.iamAuditHistoryByUser(username, { event_type: eventFilter || undefined, actor: actor || undefined })
      : api.iamAuditHistoryByTenant({ event_type: eventFilter || undefined, actor: actor || undefined }),
  });

  const entries = q.data?.items ?? [];

  return (
    <div data-testid="user-audit-history-page">
      <PageHeader
        title={username ? `Audit history — ${username}` : 'Audit history (tenant-wide)'}
        subtitle="11-value event-type closed enum with before/after JSON diff. Reuses the M15 audit chain via fan-out."
      />

      <Panel className="mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="audit-history-filters">
          <label className="block">
            <span className="text-xs text-muted">Event type</span>
            <select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value as '' | UserAuditEventType)}
              className="input"
              data-testid="audit-history-event-filter"
            >
              <option value="">(any)</option>
              {ALL_USER_AUDIT_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Actor username</span>
            <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="e.g. alice.admin" data-testid="audit-history-actor" />
          </label>
          <div className="flex items-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setEventFilter(''); setActor(''); }}
              data-testid="audit-history-reset"
            >
              <Filter size={14} className="mr-1" /> Reset
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title={`${entries.length} event${entries.length === 1 ? '' : 's'}`}>
        {q.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted flex items-center gap-2"><ScrollText size={14} /> No audit events match the current filter.</p>
        ) : (
          <ul className="text-[12px] divide-y divide-divider" data-testid="audit-history-timeline">
            {entries.map((e: UserAuditHistoryRow) => (
              <li key={e.audit_id} className="py-2" data-testid={`audit-history-row-${e.audit_id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={TONE[e.event_type] ?? 'neutral'}>{e.event_type.replace(/_/g, ' ')}</Badge>
                    <span className="text-muted text-[11px]">
                      by <strong className="text-ink">{e.actor}</strong> · {new Date(e.occurred_at).toISOString().slice(0, 19).replace('T', ' ')}
                    </span>
                    {e.correlation_id && (
                      <span className="text-[10.5px] text-muted">corr: <code>{e.correlation_id.slice(0, 12)}…</code></span>
                    )}
                  </div>
                  {(e.before_state || e.after_state) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded(expanded === e.audit_id ? null : e.audit_id)}
                      data-testid={`audit-history-diff-toggle-${e.audit_id}`}
                    >
                      {expanded === e.audit_id ? 'Hide diff' : 'Show diff'}
                    </Button>
                  )}
                </div>
                {e.comments && <div className="text-[11px] text-muted mt-1 italic">"{e.comments}"</div>}
                {expanded === e.audit_id && (
                  <div className="grid grid-cols-2 gap-3 mt-2 text-[11px]" data-testid={`audit-history-diff-${e.audit_id}`}>
                    <div>
                      <div className="text-muted uppercase tracking-wide text-[10px]">Before</div>
                      <pre className="bg-danger-bg/20 p-2 rounded mt-1 overflow-x-auto">{JSON.stringify(e.before_state ?? {}, null, 2)}</pre>
                    </div>
                    <div>
                      <div className="text-muted uppercase tracking-wide text-[10px]">After</div>
                      <pre className="bg-success-bg/20 p-2 rounded mt-1 overflow-x-auto">{JSON.stringify(e.after_state ?? {}, null, 2)}</pre>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
