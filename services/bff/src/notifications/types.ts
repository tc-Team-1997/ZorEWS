// services/bff/src/notifications/types.ts

/** Severity tone — drives the badge colour in the SPA bell. */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'danger';

/**
 * Kind discriminator for SSE consumers that want to react to specific
 * event types (e.g. live alert ticker on /alerts). Absent = generic
 * info notification — keeps the SPA bell working unchanged.
 */
export type NotificationType =
  | 'alert.created'
  | 'case.assigned'
  | 'case.closed'
  | 'scenario.run'
  | 'system';

export interface Notification {
  /** Stable id — clients dedupe on this if SSE reconnects redelivers. */
  id: string;
  ts: string;
  level: NotificationLevel;
  /** Short headline (≤ 80 chars). */
  title: string;
  /** Optional body — wraps to two lines in the dropdown. */
  body?: string;
  /** Optional deep link (relative SPA path). */
  href?: string;
  /** Optional kind discriminator — `alert.created` etc. (T2.12). */
  type?: NotificationType;
  /** Optional kind-specific payload — e.g. `{ alert_id, severity }` for
   *  `alert.created` so the SPA can update the in-memory list inline
   *  without a refetch. Loose-typed by design — clients narrow on
   *  `type`. */
  meta?: Record<string, unknown>;
}
