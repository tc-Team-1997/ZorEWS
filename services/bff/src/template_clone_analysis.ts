// services/bff/src/template_clone_analysis.ts
//
// T6 M5.13 — Rule template clone-from-library back-reference.
//
// M5.9 (single clone) + M5.10 (bulk clone) each write a `rule.create`
// audit event with `metadata.cloned_from = <library_template_id>`.
// This module is the back-reference: given a library template id,
// scan a tenant's audit history and return the set of custom
// templates that were cloned from it, newest first.
//
// Scope: per-tenant. The auditTrailStore is per-tenant scoped, so
// this answers "which of MY custom templates trace back to this
// library template?" — not the cross-tenant "how many tenants
// have cloned this?" question, which would need a separate
// platform-wide store.
//
// Companion to M5.7 (per-custom-template audit history): that
// route says "show me the audit trail for THIS custom template";
// this route says "show me every custom template cloned from
// THIS library template" — opposite direction across the same
// audit data.

import type { AuditEvent } from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

export interface CloneRecord {
  custom_template_id: string;
  cloned_at: string;
  cloned_by: string;
  name: string | null;
  vertical: string | null;
  category: string | null;
}

export interface TemplateCloneAnalysis {
  library_template_id: string;
  total_clones: number;
  /** Newest-first ordering. */
  clones: CloneRecord[];
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
 * set of custom templates cloned from `library_template_id`. Caller
 * passes the full chain (typically via
 * `auditTrailStore.list(tenant, {page_size: max}).items`).
 *
 * Filter:
 *   action === 'rule.create'
 *   resource_type === 'rule'
 *   metadata.cloned_from === library_template_id
 *
 * The M9.4-style monotonic `event_id` doesn't matter here — sort by
 * `ts` desc with event_id asc tie-break so two clones recorded at
 * the same instant stay in stable order.
 */
export function analyseTemplateCloneHistory(
  events: readonly AuditEvent[],
  library_template_id: string,
): TemplateCloneAnalysis {
  const clones: CloneRecord[] = [];
  for (const e of events) {
    if (e.action !== 'rule.create') continue;
    if (e.resource_type !== 'rule') continue;
    const meta = e.metadata as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== 'object') continue;
    if (meta.cloned_from !== library_template_id) continue;
    clones.push({
      custom_template_id: e.resource_id,
      cloned_at: e.ts,
      cloned_by: e.actor_username,
      name: readString(meta, 'name'),
      vertical: readString(meta, 'vertical'),
      category: readString(meta, 'category'),
    });
  }
  clones.sort((a, b) => {
    if (a.cloned_at !== b.cloned_at) return a.cloned_at < b.cloned_at ? 1 : -1;
    if (a.custom_template_id !== b.custom_template_id) {
      return a.custom_template_id < b.custom_template_id ? -1 : 1;
    }
    return 0;
  });

  return {
    library_template_id,
    total_clones: clones.length,
    clones,
    latest_clone_at: clones[0]?.cloned_at ?? null,
    latest_cloner: clones[0]?.cloned_by ?? null,
  };
}
