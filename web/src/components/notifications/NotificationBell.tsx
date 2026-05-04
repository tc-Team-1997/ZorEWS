import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCircle2, Info, AlertTriangle, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
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
        aria-label={`Notifications (${unread} unread)`}
        data-testid="notification-bell"
        className="relative inline-flex items-center justify-center w-9 h-9 rounded-full hover:bg-divider/60 transition-colors"
      >
        <Bell size={16} className="text-ink-sub" strokeWidth={1.75} />
        {unread > 0 && (
          <span
            data-testid="notification-unread-badge"
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold flex items-center justify-center"
          >
            {unread > 9 ? '9+' : unread}
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
          {notifications.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-muted">
              No notifications yet. Run a scenario or wait for an SLA breach.
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
