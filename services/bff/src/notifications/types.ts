// services/bff/src/notifications/types.ts

/** Severity tone — drives the badge colour in the SPA bell. */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'danger';

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
}
