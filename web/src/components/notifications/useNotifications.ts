import { useEffect, useState } from 'react';
import { http } from '@/lib/http';

export type NotificationLevel = 'info' | 'success' | 'warning' | 'danger';

export type NotificationType =
  | 'alert.created'
  | 'case.assigned'
  | 'case.closed'
  | 'scenario.run'
  | 'system';

export interface Notification {
  id: string;
  ts: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  href?: string;
  /** Kind discriminator — `alert.created` etc. (T2.12). */
  type?: NotificationType;
  /** Kind-specific payload. */
  meta?: Record<string, unknown>;
}

interface State {
  notifications: Notification[];
  unread: number;
  connected: boolean;
}

const MAX_KEEP = 50;

/**
 * Subscribes to /v1/notifications/stream via EventSource. Maintains the
 * 50 most-recent notifications in memory + an unread count cleared by
 * `markAllRead()`. Reconnect is automatic (browser native EventSource
 * behaviour); we only manage the state on each event.
 *
 * The EventSource constructor doesn't carry axios headers, so we rely
 * on the BFF's RBAC middleware allowing cookie-less requests if the
 * role header is forwarded by an upstream proxy. For local MSW dev the
 * mock always answers regardless of headers.
 */
export function useNotifications(): State & {
  markAllRead: () => void;
  publishTest: () => Promise<void>;
} {
  const [state, setState] = useState<State>({
    notifications: [],
    unread: 0,
    connected: false,
  });

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(`${baseUrl()}/v1/notifications/stream`, {
      withCredentials: true,
    });

    const onOpen = () => setState((s) => ({ ...s, connected: true }));
    const onError = () => setState((s) => ({ ...s, connected: false }));
    const onMessage = (ev: MessageEvent<string>) => {
      try {
        const n = JSON.parse(ev.data) as Notification;
        setState((s) => {
          if (s.notifications.some((x) => x.id === n.id)) return s; // dedupe
          const next = [n, ...s.notifications].slice(0, MAX_KEEP);
          return { ...s, notifications: next, unread: s.unread + 1 };
        });
      } catch {
        /* malformed payload — drop silently */
      }
    };

    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    es.addEventListener('notification', onMessage as EventListener);

    return () => {
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.removeEventListener('notification', onMessage as EventListener);
      es.close();
    };
  }, []);

  return {
    ...state,
    markAllRead: () => setState((s) => ({ ...s, unread: 0 })),
    publishTest: async () => {
      // Admin-only — POST a synthetic notification so demos can prove
      // the round-trip without firing a scenario or breaching an SLA.
      await http.post('/v1/notifications/publish', {
        level: 'info' as NotificationLevel,
        title: 'Test notification',
        body: 'Sent from the bell — admins only.',
      });
    },
  };
}

function baseUrl(): string {
  // Vite injects `import.meta.env.VITE_API_BASE_URL` when set; fall back
  // to same-origin so MSW (which intercepts fetch + EventSource) works.
  const v = (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env;
  return v?.VITE_API_BASE_URL ?? '';
}
