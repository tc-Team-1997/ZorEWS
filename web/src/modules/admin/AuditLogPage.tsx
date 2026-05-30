import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth, type AuthAuditEvent, type AuthEventType } from '@/store/auth';
import {
  downloadAuthAuditCsv,
  downloadAuthAuditPdf,
  downloadAuthAuditXlsx,
} from '@/lib/authAuditExport';

const EVENT_TYPES: { value: AuthEventType | ''; label: string }[] = [
  { value: '', label: 'All event types' },
  { value: 'login_success', label: 'Login — success' },
  { value: 'login_failure', label: 'Login — failure' },
  { value: 'login_rate_limited', label: 'Login — rate limited' },
  { value: 'login_locked', label: 'Login — locked account' },
  { value: 'auto_lockout_triggered', label: 'Auto-lockout triggered' },
  { value: 'auto_lockout_released', label: 'Auto-lockout released' },
  { value: 'password_reset_request', label: 'Password reset — request' },
  { value: 'password_reset_request_unknown', label: 'Password reset — unknown user' },
  { value: 'password_reset_request_rate_limited', label: 'Password reset — rate limited' },
  { value: 'password_reset_complete', label: 'Password reset — complete' },
  { value: 'admin_password_reset', label: 'Admin password reset' },
  { value: 'user_created', label: 'User created' },
  { value: 'user_deleted', label: 'User deleted' },
  { value: 'user_locked', label: 'User locked' },
  { value: 'user_unlocked', label: 'User unlocked' },
  { value: 'register_success', label: 'Register — success' },
];

// Map each event type to a Badge tone so the operator can scan the table
// and see security-relevant events at a glance.
function toneFor(t: AuthEventType): 'success' | 'warning' | 'danger' | 'neutral' {
  if (
    t === 'login_failure' ||
    t === 'auto_lockout_triggered' ||
    t === 'login_locked' ||
    t === 'user_locked' ||
    t === 'login_rate_limited' ||
    t === 'password_reset_request_rate_limited' ||
    t === 'password_reset_request_unknown'
  ) {
    return 'danger';
  }
  if (
    t === 'admin_password_reset' ||
    t === 'auto_lockout_released' ||
    t === 'password_reset_request' ||
    t === 'user_unlocked'
  ) {
    return 'warning';
  }
  if (t === 'login_success' || t === 'password_reset_complete' || t === 'user_created' || t === 'register_success') {
    return 'success';
  }
  return 'neutral';
}

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export function AuditLogPage() {
  const adminAuditLog = useAuth((s) => s.adminAuditLog);
  const [type, setType] = useState<AuthEventType | ''>('');
  const [target, setTarget] = useState('');

  const query = useQuery({
    queryKey: ['audit-log', type, target],
    queryFn: () =>
      adminAuditLog({
        type: type === '' ? undefined : type,
        target_username: target.trim() || undefined,
        limit: 500,
      }),
  });

  const events = query.data ?? [];
  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    return counts;
  }, [events]);

  return (
    <div>
      <PageHeader
        title="Auth audit log"
        subtitle="Every authentication-related event captured server-side · admin + supervisor only"
        actions={
          <div className="flex items-center gap-2" data-testid="auth-audit-export-row">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadAuthAuditCsv(events)}
              disabled={!events.length}
              data-testid="auth-audit-export-csv"
              title={
                events.length
                  ? `Export ${events.length} filtered event(s) as CSV`
                  : 'No events to export'
              }
            >
              <Download size={13} strokeWidth={2} /> CSV
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadAuthAuditPdf(events)}
              disabled={!events.length}
              data-testid="auth-audit-export-pdf"
              title={
                events.length
                  ? `Export ${events.length} filtered event(s) as PDF`
                  : 'No events to export'
              }
            >
              <Download size={13} strokeWidth={2} /> PDF
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void downloadAuthAuditXlsx(events);
              }}
              disabled={!events.length}
              data-testid="auth-audit-export-xlsx"
              title={
                events.length
                  ? `Export ${events.length} filtered event(s) as Excel`
                  : 'No events to export'
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
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw size={14} className="mr-1.5" />
            {query.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block">
            <span className="label">Event type</span>
            <select
              className="input"
              value={type}
              onChange={(e) => setType(e.target.value as AuthEventType | '')}
              data-testid="filter-type"
            >
              {EVENT_TYPES.map((t) => (
                <option key={t.value || 'all'} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Target username</span>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="text"
                className="input pl-8"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="filter by exact username"
                data-testid="filter-target"
              />
            </div>
          </label>
          <div className="flex items-end">
            <p className="caption">
              Showing <span className="font-mono">{events.length}</span> events.
            </p>
          </div>
        </div>
      </Panel>

      {Object.keys(stats).length > 0 && (
        <Panel title="At a glance" className="mb-4">
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats)
              .sort((a, b) => b[1] - a[1])
              .map(([t, n]) => (
                <span
                  key={t}
                  className="text-[11px] inline-flex items-center gap-1.5 px-2 py-1 rounded bg-surface-alt border border-divider"
                  data-testid={`stat-${t}`}
                >
                  <Badge tone={toneFor(t as AuthEventType)}>{t}</Badge>
                  <span className="font-mono text-ink-sub">{n}</span>
                </span>
              ))}
          </div>
        </Panel>
      )}

      <Panel title="Events">
        {query.isLoading && <p className="caption">Loading audit log…</p>}
        {query.isError && (
          <p role="alert" className="text-danger text-sm">
            <ShieldAlert size={14} className="inline mr-1.5 -mt-0.5" />
            Could not load audit log. You may not have admin or supervisor access.
          </p>
        )}
        {query.data && events.length === 0 && (
          <p className="caption">No events match the current filter.</p>
        )}
        {events.length > 0 && (
          <div className="overflow-x-auto" data-testid="audit-table">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left border-b border-divider text-muted">
                  <th className="py-2 px-3 font-medium">Timestamp</th>
                  <th className="py-2 px-3 font-medium">Event</th>
                  <th className="py-2 px-3 font-medium">Target</th>
                  <th className="py-2 px-3 font-medium">Actor</th>
                  <th className="py-2 px-3 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e: AuthAuditEvent) => (
                  <tr
                    key={e.id}
                    data-testid={`row-${e.id}`}
                    className="border-b border-divider/60 hover:bg-surface-alt/40"
                  >
                    <td className="py-2 px-3 font-mono text-ink-sub whitespace-nowrap">{fmtTs(e.ts)}</td>
                    <td className="py-2 px-3">
                      <Badge tone={toneFor(e.type)}>{e.type}</Badge>
                    </td>
                    <td className="py-2 px-3 font-mono text-ink">{e.target_username ?? '—'}</td>
                    <td className="py-2 px-3 text-ink-sub">
                      {e.actor_username ? (
                        <>
                          <span className="font-mono">{e.actor_username}</span>
                          {e.actor_role && (
                            <span className="text-[10px] text-muted ml-1.5">({e.actor_role})</span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 px-3 font-mono text-muted">{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel className="mt-4">
        <p className="caption">
          The audit log is a write-once stream of every authentication event
          captured by auth-svc. In this prototype it's an in-memory ring buffer
          (1,000 entries); production swaps in a Postgres append-only table with
          7-year retention per RBI norms.
        </p>
      </Panel>
    </div>
  );
}
