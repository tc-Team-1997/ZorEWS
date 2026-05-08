// LiveActivityFeed — surfaces the in-process notifications bus as a
// rolling activity log on the home dashboard. Builds on T2.12's typed
// SSE: every alert.created / case.assigned / case.closed / alert.updated
// event lands here in near-real-time.
//
// Reuses the existing `useNotifications` hook (one EventSource per tab)
// so the bell + this feed stay in sync without a second subscription.

import { Bell, AlertTriangle, BadgeCheck, UserPlus, Settings } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Panel } from '@/components/ui';
import {
  useNotifications,
  type Notification,
  type NotificationType,
} from '@/components/notifications/useNotifications';

// alert.ack/unack events ride on `type: 'system'` (the bus doesn't model
// `alert.updated` separately — that's the external-webhook event type
// only). The system-tinted row covers both ack and unack here.
const TYPE_META: Record<
  NotificationType | 'unknown',
  { label: string; icon: typeof Bell; tint: string }
> = {
  'alert.created':  { label: 'Alert',     icon: AlertTriangle, tint: 'text-rose-700 bg-rose-50' },
  'case.assigned':  { label: 'Case',      icon: UserPlus,      tint: 'text-blue-700 bg-blue-50' },
  'case.closed':    { label: 'Case',      icon: BadgeCheck,    tint: 'text-emerald-700 bg-emerald-50' },
  'scenario.run':   { label: 'Scenario',  icon: Settings,      tint: 'text-slate-700 bg-slate-100' },
  'system':         { label: 'System',    icon: Bell,          tint: 'text-slate-700 bg-slate-100' },
  unknown:          { label: 'Update',    icon: Bell,          tint: 'text-slate-700 bg-slate-100' },
};

const MAX_VISIBLE = 8;

function relativeTime(isoTs: string): string {
  const ageMs = Date.now() - Date.parse(isoTs);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'just now';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function LiveActivityFeed() {
  const { notifications, connected } = useNotifications();
  const items = notifications.slice(0, MAX_VISIBLE);

  return (
    <Panel
      title="Live activity"
      action={
        <span
          className="text-[11px] text-ink-sub flex items-center gap-1.5"
          data-testid="live-activity-status"
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              connected ? 'bg-emerald-500' : 'bg-slate-400'
            }`}
            aria-hidden
          />
          {connected ? 'Live' : 'Offline'}
        </span>
      }
    >
      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          No activity yet — alerts, case assignments and acks land here in real time.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="live-activity-list">
          {items.map((n) => (
            <ActivityRow key={n.id} n={n} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ActivityRow({ n }: { n: Notification }) {
  const meta = TYPE_META[n.type ?? 'unknown'];
  const Icon = meta.icon;
  const inner = (
    <div
      className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-slate-50 transition-colors"
      data-testid={`live-activity-row-${n.id}`}
      data-event-type={n.type ?? 'unknown'}
    >
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${meta.tint}`}
        aria-hidden
      >
        <Icon size={12} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2 text-[13px]">
          <span className="font-medium truncate text-ink">{n.title}</span>
          <span className="shrink-0 tabular text-[11px] text-slate-500">
            {relativeTime(n.ts)}
          </span>
        </div>
        {n.body && (
          <div className="text-[11px] text-slate-600 truncate">{n.body}</div>
        )}
      </div>
    </div>
  );
  return (
    <li>
      {n.href ? (
        <Link to={n.href} className="block no-underline">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </li>
  );
}
