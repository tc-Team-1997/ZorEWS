// services/bff/src/audit_actor_heatmap.ts
//
// T6 M15.24 — Audit event actor frequency heatmap.
//
// Analyze audit events to create a 7×24 dow×hour heatmap per actor.
// Group all audit events by actor_username, then for each actor count
// events by (day_of_week 0-6 Mon-Sun, hour_of_day 0-23).
// Returns top 5 actors by event count with their heatmap matrix.

import { type AuditTrailStore } from './audit_trail';

export interface ActorHeatmapRow {
  actor_username: string;
  total_events: number;
  heatmap: number[][]; // [7][24]
  peak_dow: number | null;
  peak_hour: number | null;
}

export interface AuditActorHeatmapResult {
  tenant_id: string;
  generated_at: string;
  top_actors: ActorHeatmapRow[];
  total_events_analyzed: number;
}

function emptyMatrix(): number[][] {
  return Array.from({ length: 7 }, () => new Array(24).fill(0));
}

// JS getUTCDay: 0=Sun, 1=Mon...6=Sat → convert to ISO Mon=0..Sun=6
function jsUTCDayToISO(jsDay: number): number {
  return (jsDay + 6) % 7;
}

export function buildAuditActorHeatmap(
  store: AuditTrailStore,
  tenant_id: string,
  now: Date,
): AuditActorHeatmapResult {
  if (!tenant_id) throw new Error('tenant_id required');

  // Drain all events
  const allEvents: Array<{ actor_username: string; ts: string }> = [];
  for (let page = 1; page <= 200; page++) {
    const result = store.list(tenant_id, { page, page_size: 1000 });
    for (const ev of result.items) {
      allEvents.push({ actor_username: ev.actor_username, ts: ev.ts });
    }
    if (result.items.length < 1000) break;
  }

  // Group by actor
  const byActor = new Map<string, { matrix: number[][]; total: number }>();

  for (const ev of allEvents) {
    if (!ev.actor_username) continue;
    const d = new Date(ev.ts);
    if (isNaN(d.getTime())) continue;

    const dow = jsUTCDayToISO(d.getUTCDay());
    const hour = d.getUTCHours();

    if (!byActor.has(ev.actor_username)) {
      byActor.set(ev.actor_username, { matrix: emptyMatrix(), total: 0 });
    }
    const entry = byActor.get(ev.actor_username)!;
    entry.matrix[dow][hour]++;
    entry.total++;
  }

  // Get top 5 actors by event count
  const sorted = [...byActor.entries()].sort(
    (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
  );
  const top5 = sorted.slice(0, 5);

  const top_actors: ActorHeatmapRow[] = top5.map(([actor, { matrix, total }]) => {
    let peak_dow: number | null = null;
    let peak_hour: number | null = null;
    let maxVal = -1;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const v = matrix[d][h];
        if (v > maxVal) { maxVal = v; peak_dow = d; peak_hour = h; }
      }
    }
    if (maxVal <= 0) { peak_dow = null; peak_hour = null; }
    return {
      actor_username: actor,
      total_events: total,
      heatmap: matrix,
      peak_dow,
      peak_hour,
    };
  });

  return {
    tenant_id,
    generated_at: now.toISOString(),
    top_actors,
    total_events_analyzed: allEvents.length,
  };
}
