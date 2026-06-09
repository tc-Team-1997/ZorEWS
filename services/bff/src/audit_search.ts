// services/bff/src/audit_search.ts
//
// T6 M15.21 — Audit event full-text search.
//
// Enables investigators to search across all recorded AuditEvents for
// a given tenant using a free-text query. Case-insensitive substring
// matching across key fields: actor_username, action, resource_id,
// resource_type, outcome, severity, and JSON.stringify(metadata).
//
// Distinct from:
//   M15.1 — filtered LIST (exact field filters; no text search)
//   M15.6 — action CATALOG (per-action stats, no search)
//   M15.8 — per-ACTOR rollup (actor pivot; no text search)
//
// Results are returned newest-first (same ordering as M15.1 list),
// limited to [1, 200] with default 50. Shows a 200-char snippet with
// context from the first matching field.
//
// Drives: "did we ever have an admin action on case CASE-XYZ?" or
// "find all events mentioning compliance@bil.bt" without writing a
// bespoke filter.

import type { AuditEvent } from './audit_trail';

// ─── Constants ─────────────────────────────────────────────────────────

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;
const SNIPPET_LENGTH = 200;

// ─── Public types ──────────────────────────────────────────────────────

export interface AuditSearchResult {
  event_id: string;
  ts: string;
  actor_username: string;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: string;
  severity: string;
  /** Which fields contained the query string. */
  match_fields: string[];
  /** Up to 200-char context snippet from the first matching field. */
  snippet: string;
}

export interface AuditSearchResponse {
  tenant_id: string;
  generated_at: string;
  query: string;
  total_events_scanned: number;
  match_count: number;
  /** True if results were trimmed to the limit. */
  limited: boolean;
  results: AuditSearchResult[];
}

export class AuditSearchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuditSearchError';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function buildSnippet(text: string, query: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, SNIPPET_LENGTH) + (text.length > SNIPPET_LENGTH ? '…' : '');

  const half = Math.floor(SNIPPET_LENGTH / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, idx + query.length + half);
  const snippet = text.slice(start, end);
  return (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '');
}

// ─── Implementation ─────────────────────────────────────────────────────

export function searchAuditEvents(
  tenant_id: string,
  events: AuditEvent[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): AuditSearchResponse {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new AuditSearchError('invalid_input', 'tenant_id is required');
  }

  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  if (trimmedQuery.length < MIN_QUERY_LENGTH) {
    throw new AuditSearchError(
      'invalid_query',
      `query must be at least ${MIN_QUERY_LENGTH} characters`,
    );
  }
  if (trimmedQuery.length > MAX_QUERY_LENGTH) {
    throw new AuditSearchError(
      'invalid_query',
      `query must be at most ${MAX_QUERY_LENGTH} characters`,
    );
  }

  if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw new AuditSearchError(
      'invalid_limit',
      `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`,
    );
  }

  const lowerQuery = trimmedQuery.toLowerCase();

  // Fields to search
  const FIELDS: Array<{ key: keyof AuditEvent | 'metadata'; label: string }> = [
    { key: 'actor_username', label: 'actor_username' },
    { key: 'action', label: 'action' },
    { key: 'resource_id', label: 'resource_id' },
    { key: 'resource_type', label: 'resource_type' },
    { key: 'outcome', label: 'outcome' },
    { key: 'severity', label: 'severity' },
    { key: 'metadata', label: 'metadata' },
  ];

  const matched: AuditSearchResult[] = [];

  for (const event of events) {
    const matchFields: string[] = [];
    let firstSnippet: string | null = null;

    for (const { key, label } of FIELDS) {
      let raw: string;
      if (key === 'metadata') {
        try {
          raw = JSON.stringify(event.metadata ?? {});
        } catch {
          raw = '';
        }
      } else {
        raw = String((event as unknown as Record<string, unknown>)[key] ?? '');
      }

      if (raw.toLowerCase().includes(lowerQuery)) {
        matchFields.push(label);
        if (firstSnippet == null) {
          firstSnippet = buildSnippet(raw, trimmedQuery);
        }
      }
    }

    if (matchFields.length > 0) {
      matched.push({
        event_id: event.event_id,
        ts: event.ts,
        actor_username: event.actor_username,
        action: event.action,
        resource_type: event.resource_type,
        resource_id: event.resource_id,
        outcome: event.outcome,
        severity: event.severity,
        match_fields: matchFields,
        snippet: firstSnippet ?? '',
      });
    }
  }

  // Sort newest-first
  matched.sort((a, b) => {
    const ta = new Date(a.ts).getTime();
    const tb = new Date(b.ts).getTime();
    if (tb !== ta) return tb - ta;
    return a.event_id.localeCompare(b.event_id);
  });

  const limited = matched.length > limit;
  const results = matched.slice(0, limit);

  return {
    tenant_id,
    generated_at: new Date().toISOString(),
    query: trimmedQuery,
    total_events_scanned: events.length,
    match_count: matched.length,
    limited,
    results,
  };
}
