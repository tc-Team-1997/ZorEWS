// Live alert stream hook — T2.12.
//
// Subscribes to /v1/notifications/stream and filters on type =
// `alert.created`. Page components can use this to show a "N new alerts"
// banner that nudges the user to refresh the list, plus an
// `onNewAlert` callback to invalidate the react-query cache automatically.
//
// Shares the same SSE feed as `useNotifications` so the bell + the live
// banner stay in sync — there's only one EventSource per tab.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Notification } from './useNotifications';

interface State {
  /** New `alert.created` events since the last `clear()`. */
  pending: Notification[];
  /** Total seen since mount — useful for the bell or a live indicator. */
  totalSeen: number;
  /** EventSource open / closed. */
  connected: boolean;
}

export function useAlertStream(opts: {
  /** When set, this query key gets invalidated on every new event. The
   *  AlertListPage uses `['alerts', ...filters]` so its useQuery refetches. */
  invalidateQueryKey?: readonly unknown[];
} = {}): State & { clear: () => void } {
  const qc = useQueryClient();
  const [state, setState] = useState<State>({
    pending: [],
    totalSeen: 0,
    connected: false,
  });
  // Capture the latest invalidate target without re-subscribing on each render.
  const targetRef = useRef(opts.invalidateQueryKey);
  targetRef.current = opts.invalidateQueryKey;

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
        if (n.type !== 'alert.created') return;
        setState((s) => {
          if (s.pending.some((x) => x.id === n.id)) return s; // dedupe
          return {
            ...s,
            pending: [n, ...s.pending].slice(0, 100),
            totalSeen: s.totalSeen + 1,
          };
        });
        // Best-effort invalidate so the alerts list refetches in the background.
        if (targetRef.current) {
          void qc.invalidateQueries({ queryKey: targetRef.current as unknown[] });
        }
      } catch {
        /* malformed payload — drop */
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
  }, [qc]);

  return {
    ...state,
    clear: () => setState((s) => ({ ...s, pending: [] })),
  };
}

function baseUrl(): string {
  const v = (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env;
  return v?.VITE_API_BASE_URL ?? '';
}
