// services/bff/src/alert_quiet_hours_mute.ts
//
// T6 M10.8 — Alert acknowledgment auto-mute via M10.7 quiet hours.
//
// M10.7 ships per-user quiet-hours windows that suppress notification
// CHANNELS (email/sms/push). M10.8 closes the loop on the ALERT side:
// when an alert is ingested via M8.5 (`/v1/alerts/ingest`) and the
// designated target user is currently inside their quiet-hours window,
// the alert is auto-acknowledged with reason "quiet hours" and the
// synthetic actor `system:quiet-hours-mute`. This stops the alert from
// pinging the dashboard / pushing the user during their off-hours.
//
// Design choices:
//  - RED severity BYPASSES quiet hours (operator pages on critical
//    even at night). YELLOW/ORANGE/GREEN auto-mute.
//  - Runs AFTER the M8.4 auto-ack rule evaluation. If the M8.4 rule
//    already matched and acked, M10.8 is a no-op (skip reason
//    `already_acknowledged`).
//  - Pure-function evaluator + a small per-(tenant,user) event store
//    so the user can review what was muted on their behalf.
//  - Event store FIFO-caps at 200 entries per user (rolling window).
//  - Webhook channel bypass from M10.7 doesn't apply here — that's
//    about CHANNEL routing; M10.8 is about the alert state itself.

import { isInQuietHours, type NotificationPreferenceStore } from './notification_preferences';
import { type BilAlertClass } from './bil_alert_classification';
import {
  type AlertAckState,
  type AlertAckStore,
  AlertAckError,
} from './alert_ack';

/** Synthetic actor stamped on the ack history when quiet-hours mute fires. */
export const QUIET_HOURS_MUTE_ACTOR = 'system:quiet-hours-mute';

/** Severities that bypass quiet-hours mute (operator still pages on these). */
export const QUIET_HOURS_BYPASS_CLASSES: readonly BilAlertClass[] = ['red'];

/** Per-user FIFO cap for the audit trail. */
export const QUIET_HOURS_MUTE_EVENT_CAP = 200;

export type QuietHoursMuteSkipReason =
  | 'no_target_user'
  | 'no_quiet_hours'
  | 'outside_quiet_hours'
  | 'critical_severity'
  | 'already_acknowledged';

export interface QuietHoursMuteDecision {
  /** True iff the alert was auto-acked by this evaluator. */
  applied: boolean;
  /** When applied=false, why we skipped. null when applied. */
  skipped: QuietHoursMuteSkipReason | null;
  /** Live ack state after the decision. */
  ack_state: AlertAckState;
  /** Human-readable note used as the ack reason when applied. */
  reason?: string;
  /** Echoed back so callers don't need to re-pass it. */
  target_username?: string;
}

export interface QuietHoursMuteEvent {
  tenant_id: string;
  username: string;
  alert_id: string;
  bil_class: BilAlertClass;
  muted_at: string;
  reason: string;
}

export interface QuietHoursMuteEventStore {
  record(e: QuietHoursMuteEvent): void;
  /** Newest-first; optional `since` filter on muted_at. */
  listForUser(
    tenant_id: string,
    username: string,
    since?: Date,
    limit?: number,
  ): readonly QuietHoursMuteEvent[];
  countForUser(tenant_id: string, username: string): number;
  /** Clear a user's history (used by tests + the SPA "clear" button). */
  clearForUser(tenant_id: string, username: string): number;
  /** T6 M10.9 — newest-first list across every user in the tenant.
   *  Optional `since` filter on muted_at. Used by the analytics
   *  rollup to span all users for a tenant-wide view. */
  listAllForTenant(tenant_id: string, since?: Date): readonly QuietHoursMuteEvent[];
}

export class InMemoryQuietHoursMuteEventStore implements QuietHoursMuteEventStore {
  private readonly map = new Map<string, QuietHoursMuteEvent[]>();

  private k(tenant_id: string, username: string): string {
    return `${tenant_id}::${username}`;
  }

  record(e: QuietHoursMuteEvent): void {
    const k = this.k(e.tenant_id, e.username);
    const arr = this.map.get(k) ?? [];
    arr.push(e);
    while (arr.length > QUIET_HOURS_MUTE_EVENT_CAP) arr.shift();
    this.map.set(k, arr);
  }

  listForUser(
    tenant_id: string,
    username: string,
    since?: Date,
    limit?: number,
  ): readonly QuietHoursMuteEvent[] {
    const arr = this.map.get(this.k(tenant_id, username)) ?? [];
    const filtered = since
      ? arr.filter((e) => new Date(e.muted_at).getTime() >= since.getTime())
      : arr;
    // Newest-first
    const newestFirst = [...filtered].reverse();
    return typeof limit === 'number' && limit > 0
      ? newestFirst.slice(0, limit)
      : newestFirst;
  }

  countForUser(tenant_id: string, username: string): number {
    return this.map.get(this.k(tenant_id, username))?.length ?? 0;
  }

  clearForUser(tenant_id: string, username: string): number {
    const k = this.k(tenant_id, username);
    const n = this.map.get(k)?.length ?? 0;
    this.map.delete(k);
    return n;
  }

  listAllForTenant(tenant_id: string, since?: Date): readonly QuietHoursMuteEvent[] {
    const prefix = `${tenant_id}::`;
    const out: QuietHoursMuteEvent[] = [];
    for (const [k, arr] of this.map) {
      if (!k.startsWith(prefix)) continue;
      for (const e of arr) {
        if (since && new Date(e.muted_at).getTime() < since.getTime()) continue;
        out.push(e);
      }
    }
    // Newest-first by muted_at.
    out.sort((a, b) => (a.muted_at < b.muted_at ? 1 : a.muted_at > b.muted_at ? -1 : 0));
    return out;
  }
}

export const defaultQuietHoursMuteEventStore: QuietHoursMuteEventStore =
  new InMemoryQuietHoursMuteEventStore();

// ── Pure evaluator ───────────────────────────────────────────────────

export interface EvaluateQuietHoursMuteArgs {
  prefStore: NotificationPreferenceStore;
  ackStore: AlertAckStore;
  muteStore: QuietHoursMuteEventStore;
  tenant_id: string;
  alert_id: string;
  bil_class: BilAlertClass;
  /** Optional. If absent, decision is `skipped: 'no_target_user'`. */
  target_username: string | undefined;
  /** True when M8.4 already auto-acked. Short-circuits with
   *  skip='already_acknowledged'. */
  already_auto_acked: boolean;
  now: Date;
}

/**
 * Pure-ish evaluator: given an alert + the target user, decides whether
 * to apply quiet-hours mute and (if so) records both the ack-state
 * transition (via `ackStore.acknowledge`) and the audit event (via
 * `muteStore.record`).
 *
 * Mutates the two stores when applied; otherwise read-only.
 */
export function evaluateQuietHoursMute(
  args: EvaluateQuietHoursMuteArgs,
): QuietHoursMuteDecision {
  const {
    prefStore,
    ackStore,
    muteStore,
    tenant_id,
    alert_id,
    bil_class,
    target_username,
    already_auto_acked,
    now,
  } = args;

  if (!target_username || !target_username.trim()) {
    return {
      applied: false,
      skipped: 'no_target_user',
      ack_state: ackStore.get(tenant_id, alert_id),
    };
  }
  const username = target_username.trim();

  if (already_auto_acked) {
    return {
      applied: false,
      skipped: 'already_acknowledged',
      ack_state: ackStore.get(tenant_id, alert_id),
      target_username: username,
    };
  }

  if (QUIET_HOURS_BYPASS_CLASSES.includes(bil_class)) {
    return {
      applied: false,
      skipped: 'critical_severity',
      ack_state: ackStore.get(tenant_id, alert_id),
      target_username: username,
    };
  }

  const pref = prefStore.get(tenant_id, username);
  if (!pref.quiet_hours) {
    return {
      applied: false,
      skipped: 'no_quiet_hours',
      ack_state: ackStore.get(tenant_id, alert_id),
      target_username: username,
    };
  }

  if (!isInQuietHours(pref.quiet_hours, now)) {
    return {
      applied: false,
      skipped: 'outside_quiet_hours',
      ack_state: ackStore.get(tenant_id, alert_id),
      target_username: username,
    };
  }

  // Apply the mute.
  const reason = `quiet hours ${pref.quiet_hours.start_hour}-${pref.quiet_hours.end_hour} UTC`;
  let ack_state: AlertAckState;
  try {
    ack_state = ackStore.acknowledge(
      tenant_id,
      alert_id,
      QUIET_HOURS_MUTE_ACTOR,
      reason,
      now,
    );
  } catch (e) {
    if (e instanceof AlertAckError && e.code === 'already_acknowledged') {
      return {
        applied: false,
        skipped: 'already_acknowledged',
        ack_state: ackStore.get(tenant_id, alert_id),
        target_username: username,
      };
    }
    throw e;
  }

  muteStore.record({
    tenant_id,
    username,
    alert_id,
    bil_class,
    muted_at: now.toISOString(),
    reason,
  });

  return {
    applied: true,
    skipped: null,
    ack_state,
    reason,
    target_username: username,
  };
}
