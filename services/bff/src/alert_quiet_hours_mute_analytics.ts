// services/bff/src/alert_quiet_hours_mute_analytics.ts
//
// T6 M10.9 — Quiet-hours mute analytics.
//
// M10.8 ships the quiet-hours auto-mute on /v1/alerts/ingest plus a
// per-user event log so each user can review what was muted on their
// behalf. M10.9 lifts that to a tenant-wide supervisor view: across
// all users, how often is quiet-hours mute firing? Who's getting
// most of their alerts muted? What classes are being muted?
//
// Design:
//  - Pure resolver over a readonly QuietHoursMuteEvent[]. Caller
//    fetches the slice (typically
//    `muteStore.listAllForTenant(tenant, since)`).
//  - top_users cap 10 — same posture as M12.5's top_requesters.
//  - by_day uses the muted_at date (YYYY-MM-DD in UTC), oldest-first.
//  - RED never appears (M10.8 bypasses red by design) but the
//    aggregator still tracks all 4 classes with zero counts where
//    none observed, so the SPA can render a stable strip.

import type { QuietHoursMuteEvent } from './alert_quiet_hours_mute';
import type { BilAlertClass } from './bil_alert_classification';

// ─── Public types ─────────────────────────────────────────────────────

const ALL_CLASSES: BilAlertClass[] = ['red', 'orange', 'yellow', 'green'];

export interface UserMuteRollup {
  username: string;
  mute_count: number;
}

export interface DailyMuteBucket {
  /** YYYY-MM-DD in UTC. */
  day: string;
  count: number;
}

export interface QuietHoursMuteAnalytics {
  sample_size: number;
  distinct_users: number;
  /** Every class key present, zero when none seen. */
  by_class: Record<BilAlertClass, number>;
  /** Per-day, oldest-first. */
  by_day: DailyMuteBucket[];
  /** Heaviest-muted users first, cap 10, tie-broken by username asc. */
  top_users: UserMuteRollup[];
}

export const TOP_USERS_CAP = 10;

// ─── Pure aggregator ──────────────────────────────────────────────────

function emptyByClass(): Record<BilAlertClass, number> {
  return { red: 0, orange: 0, yellow: 0, green: 0 };
}

function utcDay(iso: string): string {
  // muted_at is recorded via `now.toISOString()`, so YYYY-MM-DD slice
  // is the UTC day. Defensive against non-ISO inputs.
  return iso.slice(0, 10);
}

/**
 * Roll up a window of QuietHoursMuteEvent records into
 * QuietHoursMuteAnalytics. Caller is responsible for slicing the
 * window (typically `muteStore.listAllForTenant(tenant, since)`).
 */
export function summarizeQuietHoursMutes(
  events: readonly QuietHoursMuteEvent[],
): QuietHoursMuteAnalytics {
  const by_class = emptyByClass();
  const userMap = new Map<string, number>();
  const dayMap = new Map<string, number>();

  for (const e of events) {
    if (ALL_CLASSES.includes(e.bil_class)) by_class[e.bil_class] += 1;
    userMap.set(e.username, (userMap.get(e.username) ?? 0) + 1);
    const day = utcDay(e.muted_at);
    if (day) dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
  }

  const top_users: UserMuteRollup[] = [];
  for (const [username, mute_count] of userMap) {
    top_users.push({ username, mute_count });
  }
  top_users.sort((a, b) => {
    if (b.mute_count !== a.mute_count) return b.mute_count - a.mute_count;
    return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
  });

  const by_day: DailyMuteBucket[] = [];
  for (const [day, count] of dayMap) {
    by_day.push({ day, count });
  }
  by_day.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  return {
    sample_size: events.length,
    distinct_users: userMap.size,
    by_class,
    by_day,
    top_users: top_users.slice(0, TOP_USERS_CAP),
  };
}
