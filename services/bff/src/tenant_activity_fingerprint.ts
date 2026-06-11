// services/bff/src/tenant_activity_fingerprint.ts
// T6 M2.29 — Tenant activity fingerprint.

import type { AuditTrailStore } from './audit_trail';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

export interface TenantActivityFingerprint {
  tenant_id: string;
  generated_at: string;
  most_active_module: string | null;
  most_active_actor: string | null;
  most_common_action: string | null;
  peak_activity_hour: number | null;
  activity_diversity_score: number;
  fingerprint_hash: string;
}

const TOTAL_POSSIBLE_ACTIONS = 50;

export function buildTenantActivityFingerprint(
  store: AuditTrailStore,
  tenant_id: string,
  now: Date,
): TenantActivityFingerprint {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = store.list(tenant_id, {});
  const events = page.items;

  if (events.length === 0) {
    return {
      tenant_id,
      generated_at: now.toISOString(),
      most_active_module: null,
      most_active_actor: null,
      most_common_action: null,
      peak_activity_hour: null,
      activity_diversity_score: 0,
      fingerprint_hash: fnv1a(tenant_id).toString(16),
    };
  }

  // most_active_module = resource_type with most events
  const byModule = new Map<string, number>();
  const byActor = new Map<string, number>();
  const byAction = new Map<string, number>();
  const byHour = new Map<number, number>();

  for (const e of events) {
    byModule.set(e.resource_type, (byModule.get(e.resource_type) ?? 0) + 1);
    byActor.set(e.actor_username, (byActor.get(e.actor_username) ?? 0) + 1);
    byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
    const hour = new Date(e.ts).getUTCHours();
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
  }

  const most_active_module = [...byModule.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const most_active_actor = [...byActor.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const most_common_action = [...byAction.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const peak_activity_hour =
    [...byHour.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const distinct_actions = byAction.size;
  const activity_diversity_score = Math.min(
    100,
    Math.round((distinct_actions / TOTAL_POSSIBLE_ACTIONS) * 100),
  );

  const joined = [
    most_active_module ?? '',
    most_active_actor ?? '',
    most_common_action ?? '',
    String(peak_activity_hour ?? ''),
  ].join('|');
  const fingerprint_hash = fnv1a(tenant_id + joined).toString(16);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    most_active_module,
    most_active_actor,
    most_common_action,
    peak_activity_hour,
    activity_diversity_score,
    fingerprint_hash,
  };
}
