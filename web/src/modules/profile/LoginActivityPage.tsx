// web/src/modules/profile/LoginActivityPage.tsx
//
// Phase 9 T1 — "My Activity" surface.
//
// Per-user auth-svc event log (login_success / login_failure / lockout /
// 2fa_*). Sourced from `useAuth().audit_events` for the CURRENT signed-in
// user only. Mounted at /profile/activity, accessible to every signed-in
// user (no role gate).
//
// NOT to be confused with /admin/activity (AdminActivityPage) — that is
// the multi-source admin trail across ALL users (user_access_override /
// report_export / ews_rule_version reverts), admin+supervisor RBAC only.
// The two pages have different data sources, different audiences, and
// different RBAC. The Phase 9 audit (2026-05-30) explicitly kept both —
// see docs/phase9-platform-consolidation.md §T1 for the rationale.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, KeyRound, RefreshCw, ShieldOff } from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { Button } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth, type AuthAuditEvent, type AuthEventType } from '@/store/auth';

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

interface RowMeta {
  icon: typeof CheckCircle2;
  iconClass: string;
  badgeTone: 'success' | 'warning' | 'danger' | 'neutral';
  label: string;
}

function metaFor(type: AuthEventType): RowMeta {
  switch (type) {
    case 'login_success':
      return { icon: CheckCircle2, iconClass: 'text-success', badgeTone: 'success', label: 'Sign-in' };
    case 'login_failure':
      return { icon: AlertTriangle, iconClass: 'text-danger', badgeTone: 'danger', label: 'Failed sign-in' };
    case 'login_locked':
    case 'auto_lockout_triggered':
    case 'login_rate_limited':
      return { icon: ShieldOff, iconClass: 'text-danger', badgeTone: 'danger', label: 'Blocked sign-in' };
    case 'auto_lockout_released':
      return { icon: CheckCircle2, iconClass: 'text-warning', badgeTone: 'warning', label: 'Lockout released' };
    case 'password_reset_request':
    case 'password_reset_complete':
    case 'admin_password_reset':
      return { icon: KeyRound, iconClass: 'text-warning', badgeTone: 'warning', label: 'Password change' };
    default:
      return { icon: CheckCircle2, iconClass: 'text-muted', badgeTone: 'neutral', label: type };
  }
}

export function LoginActivityPage() {
  const myActivity = useAuth((s) => s.myActivity);
  const username = useAuth((s) => s.user?.username);

  const query = useQuery({
    queryKey: ['my-activity', username],
    queryFn: () => myActivity(50),
  });

  const events = query.data ?? [];

  // Headline counts so the user gets an at-a-glance security read.
  const stats = useMemo(() => {
    let success = 0;
    let failure = 0;
    let other = 0;
    for (const e of events) {
      if (e.type === 'login_success') success++;
      else if (e.type === 'login_failure') failure++;
      else other++;
    }
    const lastSuccess = events.find((e) => e.type === 'login_success');
    return { success, failure, other, lastSuccess };
  }, [events]);

  return (
    <div>
      <PageHeader
        title="Sign-in activity"
        subtitle="Your own recent sign-ins, failed attempts, and account changes — review anything that wasn't you"
      />

      {stats.lastSuccess && (
        <div
          data-testid="last-login"
          className="mb-4 rounded-md border border-divider bg-surface-alt px-4 py-3 flex items-start gap-3"
        >
          <CheckCircle2 size={16} className="text-success mt-0.5 shrink-0" />
          <div className="text-[13px]">
            <p className="text-ink">
              Last successful sign-in <span className="font-medium">{relTime(stats.lastSuccess.ts)}</span>
              {stats.lastSuccess.ip && (
                <>
                  {' '}from <span className="font-mono text-ink-sub">{stats.lastSuccess.ip}</span>
                </>
              )}
              .
            </p>
            <p className="text-muted text-[11px] mt-0.5">{fmtTs(stats.lastSuccess.ts)}</p>
          </div>
        </div>
      )}

      <Panel
        title="Recent activity"
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
        {query.isLoading && <p className="caption">Loading activity…</p>}
        {query.isError && (
          <p role="alert" className="text-danger text-sm">
            Could not load activity. Try refreshing.
          </p>
        )}

        {query.data && events.length === 0 && (
          <p className="caption">No recent activity to show.</p>
        )}

        {events.length > 0 && (
          <ul className="divide-y divide-divider" data-testid="activity-list">
            {events.map((e: AuthAuditEvent) => {
              const m = metaFor(e.type);
              const Icon = m.icon;
              return (
                <li
                  key={e.id}
                  data-testid={`activity-row-${e.id}`}
                  className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="w-8 h-8 rounded-md bg-surface-alt flex items-center justify-center shrink-0">
                    <Icon size={16} className={m.iconClass} strokeWidth={1.75} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[13px] text-ink font-medium">{m.label}</p>
                      <Badge tone={m.badgeTone}>{e.type}</Badge>
                    </div>
                    <p className="text-[11px] text-muted mt-0.5">
                      {fmtTs(e.ts)} · <span className="font-mono">{e.ip ?? '—'}</span>
                      {typeof e.metadata?.device === 'string' && (
                        <> · {e.metadata.device}</>
                      )}
                    </p>
                  </div>
                  <span className="text-[11px] text-muted whitespace-nowrap">{relTime(e.ts)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
        <Panel>
          <p className="caption">Successful sign-ins</p>
          <p className="text-2xl font-semibold text-ink mt-1" data-testid="stat-success">
            {stats.success}
          </p>
        </Panel>
        <Panel>
          <p className="caption">Failed attempts</p>
          <p
            className={`text-2xl font-semibold mt-1 ${stats.failure > 0 ? 'text-danger' : 'text-ink'}`}
            data-testid="stat-failure"
          >
            {stats.failure}
          </p>
        </Panel>
        <Panel>
          <p className="caption">Account changes</p>
          <p className="text-2xl font-semibold text-ink mt-1" data-testid="stat-other">
            {stats.other}
          </p>
        </Panel>
      </div>

      <Panel className="mt-4">
        <p className="caption">
          See sign-in attempts you don't recognise? Reset your password from the{' '}
          <a href="/forgot-password" className="text-action font-medium hover:underline">
            forgot-password page
          </a>{' '}
          and revoke other devices on the{' '}
          <a href="/profile/sessions" className="text-action font-medium hover:underline">
            sessions page
          </a>
          .
        </p>
      </Panel>
    </div>
  );
}
