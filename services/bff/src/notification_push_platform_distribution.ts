// services/bff/src/notification_push_platform_distribution.ts
//
// T6 M10.17 — Push notification platform distribution.
//
// M10.3 ships the BIL push channel with 3 platforms (fcm / apns /
// web). M10.12 ships cross-channel ledger analytics (top recipients
// per channel + total send counts). M10.14 ships per-recipient
// cross-channel rollup. M10.15 ships daily volume timeline.
// M10.16 ships template usage analytics.
//
// M10.17 lands a fresh push-specific pivot: count DISPATCHES across
// the push ledger by `PushPlatform`. A push send carries N devices
// (one per recipient); each device's platform contributes 1 to the
// distribution. Mirror of M14.27 / M5.16 / M3.13 / M7.13 1D
// distribution pattern for the push transport.
//
// Drives BIL ops "is our push traffic skewed to FCM (Android) vs
// APNS (iOS)? do we have any Web Push users at all?" view in one
// round-trip.
//
// Pure resolver — caller passes drained push ledger entries.

import type {
  PushLedgerEntry,
  PushPlatform,
  PushStatus,
} from './notifications/push';

// ─── Canonical enums ───────────────────────────────────────────────────

const ALL_PUSH_PLATFORMS: readonly PushPlatform[] = ['fcm', 'apns', 'web'] as const;
const ALL_PUSH_STATUSES: readonly PushStatus[] = ['queued', 'sent', 'failed'] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface PushPlatformRow {
  platform: PushPlatform;
  /** Total per-device dispatches counted across the ledger window
   *  for this platform. A send with N devices contributes 1 per
   *  device. */
  dispatch_count: number;
  /** Distinct send messages (message_ids) that included at least one
   *  device on this platform. */
  distinct_messages: number;
  /** Distinct user_ids across this platform's devices. */
  distinct_users: number;
  /** Per-status counts for this platform's per-device entries.
   *  Every PushStatus key always present at 0 when absent. */
  by_status: Record<PushStatus, number>;
  /** Most-recent dispatch timestamp (sent_at of the entry) — null
   *  when no dispatches. */
  most_recent_at: string | null;
}

export interface PushPlatformDistributionSummary {
  tenant_id: string;
  generated_at: string;
  total_messages: number;
  total_dispatches: number;
  platforms: PushPlatformRow[];
  /** Highest dispatch_count platform; canonical iteration tie-break
   *  (fcm wins over apns at tied counts); null on empty. */
  most_used_platform: PushPlatform | null;
  /** Platforms with dispatch_count=0 in canonical order. */
  unused_platforms: PushPlatform[];
  /** Status mix across ALL platforms combined. */
  overall_by_status: Record<PushStatus, number>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByStatus(): Record<PushStatus, number> {
  return { queued: 0, sent: 0, failed: 0 };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizePushPlatformDistribution(
  tenant_id: string,
  entries: readonly PushLedgerEntry[],
  now: Date,
): PushPlatformDistributionSummary {
  type Bucket = {
    dispatch_count: number;
    messages: Set<string>;
    users: Set<string>;
    by_status: Record<PushStatus, number>;
    most_recent_at: string | null;
  };
  const buckets = new Map<PushPlatform, Bucket>();
  for (const p of ALL_PUSH_PLATFORMS) {
    buckets.set(p, {
      dispatch_count: 0,
      messages: new Set<string>(),
      users: new Set<string>(),
      by_status: emptyByStatus(),
      most_recent_at: null,
    });
  }

  const overall_by_status = emptyByStatus();
  let total_dispatches = 0;

  for (const entry of entries) {
    for (const dev of entry.per_device) {
      if (!ALL_PUSH_PLATFORMS.includes(dev.platform)) continue;
      const b = buckets.get(dev.platform)!;
      b.dispatch_count++;
      total_dispatches++;
      b.messages.add(entry.message_id);
      // Find the corresponding device in entry.to to get user_id.
      const toDevice = entry.to.find((d) => d.device_token === dev.device_token);
      if (toDevice?.user_id) b.users.add(toDevice.user_id);
      if (ALL_PUSH_STATUSES.includes(dev.status)) {
        b.by_status[dev.status]++;
        overall_by_status[dev.status]++;
      }
      if (!b.most_recent_at || entry.sent_at > b.most_recent_at) {
        b.most_recent_at = entry.sent_at;
      }
    }
  }

  const platforms: PushPlatformRow[] = ALL_PUSH_PLATFORMS.map((p) => {
    const b = buckets.get(p)!;
    return {
      platform: p,
      dispatch_count: b.dispatch_count,
      distinct_messages: b.messages.size,
      distinct_users: b.users.size,
      by_status: { ...b.by_status },
      most_recent_at: b.most_recent_at,
    };
  });

  // most_used_platform — highest dispatch_count + canonical tie-break.
  let most_used_platform: PushPlatform | null = null;
  let mostCount = 0;
  for (const p of ALL_PUSH_PLATFORMS) {
    const c = buckets.get(p)!.dispatch_count;
    if (c > mostCount) {
      mostCount = c;
      most_used_platform = p;
    }
  }
  if (mostCount === 0) most_used_platform = null;

  const unused_platforms = ALL_PUSH_PLATFORMS.filter(
    (p) => buckets.get(p)!.dispatch_count === 0,
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_messages: entries.length,
    total_dispatches,
    platforms,
    most_used_platform,
    unused_platforms,
    overall_by_status,
  };
}
