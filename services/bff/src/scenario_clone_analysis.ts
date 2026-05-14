// services/bff/src/scenario_clone_analysis.ts
//
// T6 M16.14 — Library scenario preset clone-from back-reference.
//
// M16.8 (single clone) + M16.9 (bulk clone) each write a
// `scenario.create` audit event with `metadata.cloned_from = <library
// preset id>`. This module is the back-reference: given a library
// scenario preset id, walk the tenant's audit history and return
// the set of CUSTOM presets that were cloned from it, newest first.
//
// Direct analogue of M5.13 (rule template clone history) — same
// shape, same filter, opposite resource family. Per-tenant scope:
// "which of MY custom scenarios trace back to this library preset?"

import type { AuditEvent } from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

export interface ScenarioCloneRecord {
  custom_preset_id: string;
  cloned_at: string;
  cloned_by: string;
  name: string | null;
  category: string | null;
}

export interface ScenarioCloneAnalysis {
  library_preset_id: string;
  total_clones: number;
  /** Newest-first ordering. */
  clones: ScenarioCloneRecord[];
  /** ISO timestamp of the newest clone. null when total_clones === 0. */
  latest_clone_at: string | null;
  latest_cloner: string | null;
}

// ─── Pure analyser ────────────────────────────────────────────────────

function readString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Pure back-reference query — walks the audit window and emits the
 * set of custom scenario presets cloned from `library_preset_id`.
 * Caller passes the full chain (typically via
 * `auditTrailStore.list(tenant, {page_size: max}).items`).
 *
 * Filter:
 *   action === 'scenario.create'
 *   resource_type === 'scenario'
 *   metadata.cloned_from === library_preset_id
 *
 * Sort: cloned_at desc with custom_preset_id asc tie-break.
 */
export function analyseScenarioCloneHistory(
  events: readonly AuditEvent[],
  library_preset_id: string,
): ScenarioCloneAnalysis {
  const clones: ScenarioCloneRecord[] = [];
  for (const e of events) {
    if (e.action !== 'scenario.create') continue;
    if (e.resource_type !== 'scenario') continue;
    const meta = e.metadata as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== 'object') continue;
    if (meta.cloned_from !== library_preset_id) continue;
    clones.push({
      custom_preset_id: e.resource_id,
      cloned_at: e.ts,
      cloned_by: e.actor_username,
      name: readString(meta, 'name'),
      category: readString(meta, 'category'),
    });
  }
  clones.sort((a, b) => {
    if (a.cloned_at !== b.cloned_at) return a.cloned_at < b.cloned_at ? 1 : -1;
    if (a.custom_preset_id !== b.custom_preset_id) {
      return a.custom_preset_id < b.custom_preset_id ? -1 : 1;
    }
    return 0;
  });

  return {
    library_preset_id,
    total_clones: clones.length,
    clones,
    latest_clone_at: clones[0]?.cloned_at ?? null,
    latest_cloner: clones[0]?.cloned_by ?? null,
  };
}
