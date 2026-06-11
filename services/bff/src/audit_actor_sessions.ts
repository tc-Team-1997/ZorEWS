// services/bff/src/audit_actor_sessions.ts
// T6 M15.27 — Audit actor session analysis.
// Groups audit events by actor into sessions (events within 30 min = same session).

import { type AuditTrailStore } from './audit_trail';

const SESSION_GAP_MS = 30 * 60 * 1000; // 30 minutes

export interface ActorSessionEntry {
  actor_username: string;
  total_events: number;
  session_count: number;
  avg_events_per_session: number;
  avg_session_duration_minutes: number;
  most_recent_activity: string | null;
}

export interface AuditActorSessionsResult {
  tenant_id: string;
  generated_at: string;
  total_events_analyzed: number;
  actors: ActorSessionEntry[];
  most_active_actor: string | null;     // highest total_events
  session_heavy_actor: string | null;   // highest session_count
}

export function buildAuditActorSessions(
  auditStore: AuditTrailStore,
  tenant_id: string,
  now: Date,
): AuditActorSessionsResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = auditStore.list(tenant_id, { page: 1, page_size: 10000 });
  const events = page.items;

  const total_events_analyzed = events.length;

  // Group by actor
  const actorEvents = new Map<string, { ts: string; ms: number }[]>();
  for (const e of events) {
    if (!e.actor_username) continue;
    if (!actorEvents.has(e.actor_username)) actorEvents.set(e.actor_username, []);
    actorEvents.get(e.actor_username)!.push({ ts: e.ts, ms: new Date(e.ts).getTime() });
  }

  const allActors: ActorSessionEntry[] = [];
  for (const [actor, evList] of actorEvents) {
    // Sort by ts asc
    evList.sort((a, b) => a.ms - b.ms);

    // Group into sessions
    let session_count = 0;
    let total_duration_ms = 0;
    let total_events_in_sessions = 0;
    let sessionStart: number | null = null;
    let sessionEnd: number | null = null;
    let sessionEventCount = 0;

    for (let i = 0; i < evList.length; i++) {
      const curr = evList[i].ms;
      if (sessionStart === null) {
        // Start new session
        sessionStart = curr;
        sessionEnd = curr;
        sessionEventCount = 1;
      } else {
        const gap = curr - sessionEnd!;
        if (gap <= SESSION_GAP_MS) {
          // Extend current session
          sessionEnd = curr;
          sessionEventCount++;
        } else {
          // Close session
          session_count++;
          total_duration_ms += sessionEnd! - sessionStart;
          total_events_in_sessions += sessionEventCount;
          // Start new
          sessionStart = curr;
          sessionEnd = curr;
          sessionEventCount = 1;
        }
      }
    }
    // Close last session
    if (sessionStart !== null) {
      session_count++;
      total_duration_ms += sessionEnd! - sessionStart;
      total_events_in_sessions += sessionEventCount;
    }

    const avg_events_per_session = session_count > 0
      ? Math.round((total_events_in_sessions / session_count) * 100) / 100
      : 0;
    const avg_session_duration_minutes = session_count > 0
      ? Math.round((total_duration_ms / session_count / 60_000) * 100) / 100
      : 0;

    const most_recent_activity = evList.length > 0
      ? evList[evList.length - 1].ts
      : null;

    allActors.push({
      actor_username: actor,
      total_events: evList.length,
      session_count,
      avg_events_per_session,
      avg_session_duration_minutes,
      most_recent_activity,
    });
  }

  // Sort by total_events desc, actor_username asc tie-break; cap at 10
  allActors.sort(
    (a, b) => b.total_events - a.total_events || a.actor_username.localeCompare(b.actor_username),
  );
  const actors = allActors.slice(0, 10);

  const most_active_actor = actors.length > 0 ? actors[0].actor_username : null;

  // session_heavy_actor: highest session_count among all actors (not just top-10)
  let sessionHeavy: string | null = null;
  let maxSessions = 0;
  for (const a of allActors) {
    if (a.session_count > maxSessions || (a.session_count === maxSessions && (sessionHeavy === null || a.actor_username < sessionHeavy))) {
      if (a.session_count > maxSessions) {
        maxSessions = a.session_count;
        sessionHeavy = a.actor_username;
      }
    }
  }
  if (maxSessions === 0) sessionHeavy = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events_analyzed,
    actors,
    most_active_actor,
    session_heavy_actor: sessionHeavy,
  };
}
