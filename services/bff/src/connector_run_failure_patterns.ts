// services/bff/src/connector_run_failure_patterns.ts
//
// T6 M3.6 — Connector run failure pattern clustering.
//
// M3.5 ships connector-run analytics (success rate, latency
// percentiles, last_failure). For active triage the SRE needs a
// step further: when there ARE failures, which failures? "Top 3
// errors hitting the CBS loan-book connector this week" is the
// dashboard pulse that turns alerts into action.
//
// Design:
//  - Pure aggregator. Caller slices the window (typically
//    `ingestionRegistry.listRuns(tenant, connector, window)`).
//  - Normalizes each error_message into a cluster pattern by stripping
//    the variable bits (numbers, hex ids, ISO timestamps, quoted
//    strings, file paths). Cluster key = the normalized template.
//  - Returns top-N clusters by count, ties broken by most-recent
//    last_failed_at desc. Each cluster carries 3 raw exemplar messages
//    so the operator can read the original error verbatim.
//  - Runs without `error_message` (success / partial-with-no-error)
//    are skipped — only failure-flavored entries with text are clustered.

import { type ConnectorRun } from './ingestion';

// ─── Public types ─────────────────────────────────────────────────────

export interface FailurePattern {
  /** Normalized template (variable parts replaced with placeholders). */
  pattern: string;
  /** How many runs matched this pattern. */
  count: number;
  /** Up to 3 raw error_message strings — newest first. */
  recent_messages: string[];
  /** ISO timestamp of the newest matching run. */
  last_failed_at: string;
  /** run_id of the newest matching run — useful for drilling in. */
  sample_run_id: string;
}

export interface FailurePatternsResult {
  /** Total runs in the input window. */
  sample_size: number;
  /** Total failure-flavored runs with an error_message. */
  failure_count: number;
  /** Distinct patterns observed (before cap). */
  distinct_patterns: number;
  /** Top clusters, by count desc → last_failed_at desc, capped. */
  clusters: FailurePattern[];
}

export const TOP_CLUSTERS_CAP = 10;
const EXEMPLAR_CAP = 3;

// ─── Normalization ───────────────────────────────────────────────────

/**
 * Collapse the variable parts of an error message into a cluster key.
 * Order matters — we run the most-specific regexes first so a UUID
 * inside a quoted string isn't double-replaced.
 *
 * Exported for tests.
 */
export function normaliseError(msg: string): string {
  return (
    msg
      // ISO-8601 timestamps (with or without millis + zone).
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
      // Hex UUIDs (8-4-4-4-12).
      .replace(
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        '<UUID>',
      )
      // Single-quoted strings: 'foo bar' → '<STR>'
      .replace(/'[^']*'/g, "'<STR>'")
      // Double-quoted strings: "foo bar" → "<STR>"
      .replace(/"[^"]*"/g, '"<STR>"')
      // POSIX-style file paths /a/b/c.ext
      .replace(/\/[\w./-]{2,}/g, '<PATH>')
      // Long hex runs (length ≥ 16, e.g. SHA-256 prefixes) → <HASH>
      .replace(/\b[0-9a-fA-F]{16,}\b/g, '<HASH>')
      // Any remaining number sequence (incl. floats / negatives).
      .replace(/-?\d+(?:\.\d+)?/g, '<N>')
      // Collapse runs of whitespace.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ─── Aggregator ──────────────────────────────────────────────────────

/**
 * Cluster a window of ConnectorRun records by normalized error
 * message. Pure-function; no I/O.
 */
export function clusterRunFailures(
  runs: readonly ConnectorRun[],
): FailurePatternsResult {
  type Bucket = {
    pattern: string;
    count: number;
    recent_messages: { msg: string; at: string }[];
    last_failed_at: string;
    sample_run_id: string;
  };
  const buckets = new Map<string, Bucket>();
  let failure_count = 0;

  for (const r of runs) {
    if (r.status !== 'failure' && r.status !== 'partial') continue;
    const msg = (r.error_message ?? '').trim();
    if (!msg) continue;
    const at = r.finished_at ?? r.started_at;
    if (!at) continue;
    failure_count += 1;
    const pattern = normaliseError(msg) || '(empty)';
    let b = buckets.get(pattern);
    if (!b) {
      b = {
        pattern,
        count: 0,
        recent_messages: [],
        last_failed_at: at,
        sample_run_id: r.run_id,
      };
      buckets.set(pattern, b);
    }
    b.count += 1;
    b.recent_messages.push({ msg, at });
    if (at > b.last_failed_at) {
      b.last_failed_at = at;
      b.sample_run_id = r.run_id;
    }
  }

  // Sort exemplars newest-first and cap to 3 per bucket.
  for (const b of buckets.values()) {
    b.recent_messages.sort((a, c) => (a.at < c.at ? 1 : a.at > c.at ? -1 : 0));
    b.recent_messages.length = Math.min(b.recent_messages.length, EXEMPLAR_CAP);
  }

  const clusters: FailurePattern[] = [...buckets.values()]
    .map((b) => ({
      pattern: b.pattern,
      count: b.count,
      recent_messages: b.recent_messages.map((m) => m.msg),
      last_failed_at: b.last_failed_at,
      sample_run_id: b.sample_run_id,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.last_failed_at < b.last_failed_at ? 1 : a.last_failed_at > b.last_failed_at ? -1 : 0;
    });

  return {
    sample_size: runs.length,
    failure_count,
    distinct_patterns: buckets.size,
    clusters: clusters.slice(0, TOP_CLUSTERS_CAP),
  };
}
