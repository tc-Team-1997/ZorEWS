/**
 * M13.23 — Config override audit trail summary
 * Summarises config change events from the audit trail.
 */

import { defaultAuditTrailStore } from './audit_trail';

export interface ActorChangeSummary {
  actor: string;
  count: number;
  last_at: string;
}

export interface CategoryChangeSummary {
  category: string;
  count: number;
}

export interface AdminConfigAuditSummaryReport {
  tenant_id: string;
  generated_at: string;
  total_config_changes: number;
  by_actor: ActorChangeSummary[];
  by_category: CategoryChangeSummary[];
  most_changed_key: string | null;
  last_change_at: string | null;
  avg_per_day: number;
}

export function buildAdminConfigAuditSummary(
  tenant_id: string,
  now: Date = new Date(),
): AdminConfigAuditSummaryReport {
  if (!tenant_id) throw new Error('tenant_id required');

  // Pull config events - filter by action comma list
  const page = defaultAuditTrailStore.list(tenant_id, {
    resource_type: 'config',
  });
  const events = page.items.filter(
    (e) => e.action === 'config.update' || e.action === 'config.reset',
  );

  if (events.length === 0) {
    return {
      tenant_id,
      generated_at: now.toISOString(),
      total_config_changes: 0,
      by_actor: [],
      by_category: [],
      most_changed_key: null,
      last_change_at: null,
      avg_per_day: 0,
    };
  }

  // Actor tallies
  const actorMap = new Map<string, { count: number; last_at: string }>();
  const keyCount = new Map<string, number>();
  const categoryCount = new Map<string, number>();
  let oldest_ts = events[0].ts;
  let newest_ts = events[0].ts;

  for (const e of events) {
    const actor = e.actor_username || 'unknown';
    const current = actorMap.get(actor) ?? { count: 0, last_at: e.ts };
    actorMap.set(actor, {
      count: current.count + 1,
      last_at: e.ts > current.last_at ? e.ts : current.last_at,
    });

    // Extract key from resource_id
    if (e.resource_id) {
      keyCount.set(e.resource_id, (keyCount.get(e.resource_id) ?? 0) + 1);
      // Extract category prefix
      const parts = e.resource_id.split('.');
      if (parts.length >= 2) {
        const cat = parts[0];
        categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1);
      }
    }

    if (e.ts < oldest_ts) oldest_ts = e.ts;
    if (e.ts > newest_ts) newest_ts = e.ts;
  }

  // Build actor list, top 5
  const by_actor: ActorChangeSummary[] = [...actorMap.entries()]
    .map(([actor, data]) => ({ actor, count: data.count, last_at: data.last_at }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Build category list
  const by_category: CategoryChangeSummary[] = [...categoryCount.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  // Most changed key
  let most_changed_key: string | null = null;
  let max_key_count = 0;
  for (const [k, c] of keyCount) {
    if (c > max_key_count) {
      max_key_count = c;
      most_changed_key = k;
    }
  }

  // Avg per day
  const span_ms = new Date(newest_ts).getTime() - new Date(oldest_ts).getTime();
  const span_days = Math.max(1, span_ms / 86_400_000);
  const avg_per_day = events.length / span_days;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_config_changes: events.length,
    by_actor,
    by_category,
    most_changed_key,
    last_change_at: newest_ts,
    avg_per_day,
  };
}
