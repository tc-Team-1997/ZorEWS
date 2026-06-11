// services/bff/src/admin_config_change_frequency.ts
//
// T6 M13.21 — Admin config change frequency by key.
//
// Groups M15.1 audit events with resource_type='config' and
// action='config.update'|'config.reset' by the config key
// (resource_id), surfaces how often each key is being changed
// and when the most-recent change happened.

import type { AuditEvent } from './audit_trail';
import { DEFAULTS } from './admin_config';

// ─── Public types ──────────────────────────────────────────────────────

export type ChangeVelocity = 'high' | 'medium' | 'low';

export interface ConfigChangeFrequencyRow {
  key: string;
  category: string;
  total_changes: number;
  last_changed_at: string | null;
  days_since_last_change: number | null;
  change_velocity: ChangeVelocity;
}

export interface AdminConfigChangeFrequency {
  tenant_id: string;
  generated_at: string;
  total_change_events: number;
  unique_keys_changed: number;
  /** Sorted total_changes desc + key asc tie-break. */
  keys: ConfigChangeFrequencyRow[];
  most_changed_key: { key: string; total_changes: number } | null;
  /** Keys in DEFAULTS that have 0 changes in the audit trail. */
  stable_keys_count: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const CONFIG_CHANGE_ACTIONS = new Set(['config.update', 'config.reset']);

function velocityFor(count: number): ChangeVelocity {
  if (count > 10) return 'high';
  if (count >= 5) return 'medium';
  return 'low';
}

// ─── Pure function ─────────────────────────────────────────────────────

/**
 * buildConfigChangeFrequency
 *
 * @param tenant_id   caller's tenant
 * @param auditEvents  raw AuditEvent[] from auditTrailStore.list
 * @param now         current Date
 */
export function buildConfigChangeFrequency(
  tenant_id: string,
  auditEvents: readonly AuditEvent[],
  now: Date,
): AdminConfigChangeFrequency {
  if (!tenant_id || typeof tenant_id !== 'string' || !tenant_id.trim()) {
    throw new Error('tenant_id is required');
  }

  const nowMs = now.getTime();

  // Build category map from DEFAULTS
  const keyToCategory = new Map<string, string>();
  for (const def of DEFAULTS) {
    keyToCategory.set(def.key, def.category);
  }

  // Aggregate per-key counts
  const keyStats = new Map<string, { count: number; lastTs: string | null }>();
  let total_change_events = 0;

  for (const ev of auditEvents) {
    if (ev.tenant_id !== tenant_id) continue;
    if (ev.resource_type !== 'config') continue;
    if (!CONFIG_CHANGE_ACTIONS.has(ev.action)) continue;
    const key = ev.resource_id;
    if (!key) continue;

    total_change_events++;
    const cur = keyStats.get(key) ?? { count: 0, lastTs: null };
    cur.count++;
    if (!cur.lastTs || ev.ts > cur.lastTs) cur.lastTs = ev.ts;
    keyStats.set(key, cur);
  }

  const rows: ConfigChangeFrequencyRow[] = [];

  for (const [key, stats] of keyStats.entries()) {
    const category = keyToCategory.get(key) ?? 'unknown';
    let days_since_last_change: number | null = null;
    if (stats.lastTs) {
      const lastMs = Date.parse(stats.lastTs);
      if (Number.isFinite(lastMs)) {
        days_since_last_change = Math.floor((nowMs - lastMs) / (1000 * 60 * 60 * 24));
      }
    }
    rows.push({
      key,
      category,
      total_changes: stats.count,
      last_changed_at: stats.lastTs,
      days_since_last_change,
      change_velocity: velocityFor(stats.count),
    });
  }

  // Sort: total_changes desc, then key asc tie-break
  rows.sort((a, b) => {
    if (b.total_changes !== a.total_changes) return b.total_changes - a.total_changes;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const most_changed_key =
    rows.length > 0
      ? { key: rows[0].key, total_changes: rows[0].total_changes }
      : null;

  // Count stable keys — those in DEFAULTS that never appear in the audit trail
  const changedKeys = new Set(keyStats.keys());
  const stable_keys_count = DEFAULTS.filter((d) => !changedKeys.has(d.key)).length;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_change_events,
    unique_keys_changed: keyStats.size,
    keys: rows,
    most_changed_key,
    stable_keys_count,
  };
}
