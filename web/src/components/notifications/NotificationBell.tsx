import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, CheckCircle2, Info, AlertTriangle, XCircle, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useNotifications, type Notification, type NotificationLevel } from './useNotifications';

const ICON: Record<NotificationLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

const ICON_TONE: Record<NotificationLevel, string> = {
  info: 'text-action',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export function NotificationBell() {
  const { notifications, unread, connected, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Fetch every active case scenario so the bell can surface "what's
  // currently running" alongside live SSE events. The SSE stream only
  // emits on changes (alert.created, case.assigned, etc.) so the bell
  // would otherwise look empty on a fresh login. Refetch every 60s —
  // the active set changes rarely.
  const activeScenarios = useQuery({
    queryKey: ['notification-bell', 'active-scenarios'],
    queryFn: () => api.caseScenariosList({ status: 'ACTIVE', page_size: 200 }),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const activeRows = activeScenarios.data?.items ?? [];
  const activeCount = activeRows.length;
  // Bell badge counts SSE-unread + the active-scenarios baseline so a
  // freshly-loaded SPA shows a non-zero count when scenarios are armed.
  const badgeCount = unread + activeCount;

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggle = () => {
    setOpen((v) => {
      if (!v && unread > 0) markAllRead();
      return !v;
    });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-label={`Notifications (${unread} unread, ${activeCount} active scenarios)`}
        data-testid="notification-bell"
        className="relative inline-flex items-center justify-center w-9 h-9 rounded-full hover:bg-divider/60 transition-colors"
      >
        <Bell size={16} className="text-ink-sub" strokeWidth={1.75} />
        {badgeCount > 0 && (
          <span
            data-testid="notification-unread-badge"
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold flex items-center justify-center"
            title={
              unread > 0 && activeCount > 0
                ? `${unread} unread · ${activeCount} active scenarios`
                : unread > 0
                  ? `${unread} unread`
                  : `${activeCount} active scenarios`
            }
          >
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
        <span
          data-testid="notification-connection-dot"
          className={cn(
            'absolute bottom-0 right-0 w-2 h-2 rounded-full border border-surface',
            connected ? 'bg-success' : 'bg-muted',
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          data-testid="notification-dropdown"
          className="absolute right-0 mt-2 w-[360px] max-h-[480px] overflow-y-auto rounded-lg border border-divider bg-surface shadow-lg z-50"
          role="dialog"
        >
          <div className="px-4 py-3 border-b border-divider flex items-center justify-between">
            <p className="text-[13px] font-semibold text-ink">Notifications</p>
            <p className="text-[11px] text-muted">
              {connected ? (
                <span className="text-success">● live</span>
              ) : (
                <span className="text-muted">● reconnecting…</span>
              )}
            </p>
          </div>

          {/* Active scenarios — always visible so the dropdown isn't empty
              on a fresh login. Count + first-10 entries; "View all" jumps
              to the Case Scenarios admin page. */}
          <div
            className="border-b border-divider px-4 py-3"
            data-testid="notification-active-scenarios"
          >
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                Currently running scenarios
              </p>
              <span
                className="rounded-full bg-action/10 px-2 py-[1px] text-[11px] font-semibold text-action"
                data-testid="notification-active-scenarios-count"
              >
                {activeScenarios.isLoading ? '…' : activeCount}
              </span>
            </div>
            {activeScenarios.isLoading ? (
              <p className="text-[11px] text-muted">Loading…</p>
            ) : activeScenarios.isError ? (
              <p
                className="text-[11px] text-danger"
                role="alert"
                data-testid="notification-active-scenarios-error"
              >
                Could not load active scenarios.
              </p>
            ) : activeCount === 0 ? (
              <p
                className="text-[11px] text-muted italic"
                data-testid="notification-active-scenarios-empty"
              >
                No scenarios in ACTIVE state. Activate a scenario from the
                Case Scenarios admin page.
              </p>
            ) : (
              <>
                <ul className="space-y-1" data-testid="notification-active-scenarios-list">
                  {activeRows.slice(0, 10).map((sc) => (
                    <li key={sc.scenario_id}>
                      <Link
                        to={`/admin/case-scenarios?focus=${encodeURIComponent(sc.scenario_id)}`}
                        onClick={() => setOpen(false)}
                        className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-divider/40 transition-colors"
                        data-testid={`notification-active-scenario-${sc.scenario_id}`}
                      >
                        <Zap size={12} className="shrink-0 text-action" strokeWidth={2} />
                        <span className="flex-1 truncate text-[12px] text-ink">{sc.name}</span>
                        <span className="text-[10px] font-mono text-muted">
                          {sc.case_category} · {sc.priority}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {activeCount > 10 && (
                  <Link
                    to="/admin/case-scenarios?status=ACTIVE"
                    onClick={() => setOpen(false)}
                    className="mt-2 block text-center text-[11px] text-action hover:underline"
                  >
                    View all {activeCount} active scenarios →
                  </Link>
                )}
              </>
            )}
          </div>

          {notifications.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-muted">
              No live notifications yet. Run a scenario or wait for an SLA breach.
            </p>
          ) : (
            <ul className="divide-y divide-divider">
              {notifications.map((n) => (
                <NotificationRow key={n.id} n={n} onClick={() => setOpen(false)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationRow({ n, onClick }: { n: Notification; onClick: () => void }) {
  const Icon = ICON[n.level] ?? Info;
  const body = (
    <div className="flex items-start gap-2.5 px-4 py-3 hover:bg-divider/30 transition-colors">
      <Icon size={14} className={cn('mt-[2px] shrink-0', ICON_TONE[n.level])} strokeWidth={2} />
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-medium text-ink leading-snug">{n.title}</p>
        {n.body && <p className="text-[11px] text-sub mt-0.5 leading-snug">{n.body}</p>}
        <p className="text-[10px] text-muted mt-1 tabular">{new Date(n.ts).toLocaleTimeString()}</p>
      </div>
    </div>
  );
  if (n.href) {
    return (
      <li>
        <Link to={n.href} onClick={onClick} className="block">
          {body}
        </Link>
      </li>
    );
  }
  return <li>{body}</li>;
}
