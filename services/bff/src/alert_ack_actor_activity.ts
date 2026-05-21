// services/bff/src/alert_ack_actor_activity.ts
//
// T6 M8.18 — Alert acknowledgment per-actor activity rollup.
//
// Pivots over the M8.3 AlertAckStore by `actor_username`. Mirror of
// M15.8 audit per-actor + M9.16 case maker-checker reviewer rollup
// + M9.14 investigation note authorship pattern for the alert-ack
// surface.
//
// Each entry in an AlertAckState's `history[]` carries:
//   - ts (ISO)
//   - action ∈ {acknowledged, unacknowledged}
//   - actor_username
//   - notes (acknowledge notes OR unack reason)
//
// We group every history entry across every alert by actor, then
// compute counts + ack_rate + distinct_alerts + most-recent activity.
// Drives:
//   - "who's our most diligent operator?" recognition
//   - "are any actors only un-acking (suspicious pattern — maybe they
//     keep dismissing valid alerts)?" governance
//   - quarterly access review correlated with M1.16-class actor data
//
// Pure resolver — accepts a list of AlertAckState directly so unit
// tests don't need a store. The route handler drains the store via
// `listForTenant`.

import type { AlertAckAction, AlertAckState } from './alert_ack';

// ─── Constants ───────────────────────────────────────────────────────

/** Minimum decisions before an actor is flagged as `excessive_unacker`.
 *  Below this threshold the unack-rate signal is too noisy. */
export const EXCESSIVE_UNACKER_MIN_TOTAL = 3;

/** Unack-rate >= this threshold + total >= EXCESSIVE_UNACKER_MIN_TOTAL
 *  → actor surfaces in `excessive_unackers[]`. */
export const EXCESSIVE_UNACKER_RATE_THRESHOLD = 0.5;

// ─── Output shapes ────────────────────────────────────────────────────

export interface AlertAckActorRow {
  actor_username: string;
  total_actions: number;
  acknowledged_count: number;
  unacknowledged_count: number;
  /** ack_count / total_actions; null when total_actions = 0 (defensive). */
  ack_rate: number | null;
  distinct_alerts: number;
  /** Up to 50 alert_ids sorted asc. */
  alert_ids: string[];
  /** ISO of newest history entry by this actor; null when no actions. */
  most_recent_at: string | null;
  /** ISO of oldest history entry by this actor; null when no actions. */
  first_action_at: string | null;
}

export interface AlertAckActorActivityReport {
  tenant_id: string;
  generated_at: string;
  total_actions: number;
  total_actors: number;
  actors: AlertAckActorRow[];
  /** Actor with the highest total_actions; canonical actor_username
   *  asc tie-break. Null on empty input. */
  most_active_actor: string | null;
  /** Actors with total_actions >= EXCESSIVE_UNACKER_MIN_TOTAL AND
   *  unack_rate >= EXCESSIVE_UNACKER_RATE_THRESHOLD — surfaces
   *  operators whose acks are being reversed repeatedly. Sorted by
   *  unack_count desc + actor_username asc tie-break. */
  excessive_unackers: string[];
  /** Marginal totals across all actors — Σ acked + Σ unacked +
   *  Σ total. Convenience checksum (Σ acked + Σ unacked = Σ total). */
  by_action_totals: { acknowledged: number; unacknowledged: number };
}

const ALERT_IDS_CAP = 50;

// ─── Builder ──────────────────────────────────────────────────────────

export function summarizeAlertAckActorActivity(
  tenant_id: string,
  states: readonly AlertAckState[],
  now: Date,
): AlertAckActorActivityReport {
  interface ActorAccum {
    acknowledged: number;
    unacknowledged: number;
    alerts: Set<string>;
    first_ts: string | null;
    last_ts: string | null;
  }
  const byActor = new Map<string, ActorAccum>();

  for (const state of states) {
    for (const entry of state.history) {
      const username = entry.actor_username;
      if (typeof username !== 'string' || username.length === 0) continue;
      const action: AlertAckAction = entry.action;
      let row = byActor.get(username);
      if (!row) {
        row = {
          acknowledged: 0,
          unacknowledged: 0,
          alerts: new Set<string>(),
          first_ts: null,
          last_ts: null,
        };
        byActor.set(username, row);
      }
      if (action === 'acknowledged') row.acknowledged += 1;
      else if (action === 'unacknowledged') row.unacknowledged += 1;
      else continue; // defensive — closed enum should never hit this
      row.alerts.add(state.alert_id);
      if (!row.first_ts || entry.ts < row.first_ts) row.first_ts = entry.ts;
      if (!row.last_ts || entry.ts > row.last_ts) row.last_ts = entry.ts;
    }
  }

  const actors: AlertAckActorRow[] = [];
  let total_actions = 0;
  const totals = { acknowledged: 0, unacknowledged: 0 };

  for (const [username, accum] of byActor.entries()) {
    const total = accum.acknowledged + accum.unacknowledged;
    total_actions += total;
    totals.acknowledged += accum.acknowledged;
    totals.unacknowledged += accum.unacknowledged;
    actors.push({
      actor_username: username,
      total_actions: total,
      acknowledged_count: accum.acknowledged,
      unacknowledged_count: accum.unacknowledged,
      ack_rate: total === 0 ? null : accum.acknowledged / total,
      distinct_alerts: accum.alerts.size,
      alert_ids: [...accum.alerts].sort().slice(0, ALERT_IDS_CAP),
      most_recent_at: accum.last_ts,
      first_action_at: accum.first_ts,
    });
  }

  // Sort by total_actions desc + actor_username asc tie-break.
  actors.sort((a, b) => {
    if (b.total_actions !== a.total_actions) return b.total_actions - a.total_actions;
    return a.actor_username < b.actor_username
      ? -1
      : a.actor_username > b.actor_username
        ? 1
        : 0;
  });

  const most_active_actor = actors.length > 0 ? actors[0].actor_username : null;

  // Excessive unackers — sorted by unack_count desc + actor_username asc.
  const excessive = actors
    .filter((a) => {
      if (a.total_actions < EXCESSIVE_UNACKER_MIN_TOTAL) return false;
      const unackRate = a.total_actions === 0 ? 0 : a.unacknowledged_count / a.total_actions;
      return unackRate >= EXCESSIVE_UNACKER_RATE_THRESHOLD;
    })
    .sort((a, b) => {
      if (b.unacknowledged_count !== a.unacknowledged_count) {
        return b.unacknowledged_count - a.unacknowledged_count;
      }
      return a.actor_username < b.actor_username
        ? -1
        : a.actor_username > b.actor_username
          ? 1
          : 0;
    })
    .map((a) => a.actor_username);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_actions,
    total_actors: actors.length,
    actors,
    most_active_actor,
    excessive_unackers: excessive,
    by_action_totals: totals,
  };
}
