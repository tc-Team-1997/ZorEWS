// services/bff/src/connector_error_taxonomy.ts
//
// T6 M3.22 — Connector run error message taxonomy.
//
// Drains recent runs across all connectors and categorizes
// error_messages into common buckets (timeout / connection /
// schema / auth / rate_limit / data / unknown). Surfaces the
// most common error pattern, per-category counts + sample
// messages, and the top-5 connectors by error volume.
//
// Distinct from M3.6 (failure-pattern clustering — per-connector
// regex normalisation), M3.16 (run latency histogram), M3.19
// (freshness alert). This is the fleet-wide TAXONOMY view.
//
// Pure rollup. Tenant-scoped.

import type { IngestionRegistry } from './ingestion';

// ─── Public types ─────────────────────────────────────────────────────

export type ErrorCategory =
  | 'timeout'
  | 'connection'
  | 'schema'
  | 'auth'
  | 'rate_limit'
  | 'data'
  | 'unknown';

export interface ErrorCategoryRow {
  category: ErrorCategory;
  count: number;
  pct: number;
  sample_messages: string[];
  affected_connectors: string[];
}

export interface ConnectorErrorCountRow {
  connector_id: string;
  name: string;
  error_count: number;
}

export interface ConnectorErrorTaxonomySummary {
  tenant_id: string;
  generated_at: string;
  total_error_runs: number;
  total_connectors_with_errors: number;
  categories: ErrorCategoryRow[];
  most_common_error_category: string | null;
  connectors_with_most_errors: ConnectorErrorCountRow[];
}

// ─── Constants ────────────────────────────────────────────────────────

const RUNS_PER_CONNECTOR = 50;
const TOP_CONNECTORS_CAP = 5;
const SAMPLE_MESSAGES_CAP = 3;

// ─── Category detector ────────────────────────────────────────────────

function categorize(msg: string): ErrorCategory {
  const lower = msg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline')) {
    return 'timeout';
  }
  if (
    lower.includes('connection') ||
    lower.includes('connect') ||
    lower.includes('network') ||
    lower.includes('econnrefused') ||
    lower.includes('unreachable')
  ) {
    return 'connection';
  }
  if (
    lower.includes('schema') ||
    lower.includes('parse') ||
    lower.includes('format') ||
    lower.includes('invalid field') ||
    lower.includes('column')
  ) {
    return 'schema';
  }
  if (
    lower.includes('auth') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('403') ||
    lower.includes('401') ||
    lower.includes('credential')
  ) {
    return 'auth';
  }
  if (
    lower.includes('rate') ||
    lower.includes('throttl') ||
    lower.includes('too many') ||
    lower.includes('429') ||
    lower.includes('quota')
  ) {
    return 'rate_limit';
  }
  if (
    lower.includes('data') ||
    lower.includes('null') ||
    lower.includes('missing') ||
    lower.includes('constraint') ||
    lower.includes('validation')
  ) {
    return 'data';
  }
  return 'unknown';
}

// ─── Main pure function ───────────────────────────────────────────────

export function buildConnectorErrorTaxonomy(
  registry: IngestionRegistry,
  tenant_id: string,
  now: Date,
): ConnectorErrorTaxonomySummary {
  const connectors = registry.list(tenant_id);

  const categoryMap = new Map<
    ErrorCategory,
    { count: number; messages: string[]; connectors: Set<string> }
  >();
  const allCategories: ErrorCategory[] = [
    'timeout', 'connection', 'schema', 'auth', 'rate_limit', 'data', 'unknown',
  ];
  for (const cat of allCategories) {
    categoryMap.set(cat, { count: 0, messages: [], connectors: new Set() });
  }

  const connectorErrorCounts = new Map<string, { name: string; count: number }>();

  for (const connector of connectors) {
    const runs = registry.listRuns(tenant_id, connector.id, RUNS_PER_CONNECTOR);
    let connectorErrors = 0;

    for (const run of runs) {
      if (run.status !== 'failure' && run.status !== 'partial') continue;
      if (!run.error_message || run.error_message.trim() === '') continue;

      const cat = categorize(run.error_message);
      const entry = categoryMap.get(cat)!;
      entry.count++;
      if (entry.messages.length < SAMPLE_MESSAGES_CAP) {
        entry.messages.push(run.error_message);
      }
      entry.connectors.add(connector.id);
      connectorErrors++;
    }

    if (connectorErrors > 0) {
      connectorErrorCounts.set(connector.id, { name: connector.name, count: connectorErrors });
    }
  }

  const total_error_runs = Array.from(categoryMap.values()).reduce((s, v) => s + v.count, 0);

  // Build categories array, sort by count desc.
  const categories: ErrorCategoryRow[] = allCategories
    .map((cat) => {
      const entry = categoryMap.get(cat)!;
      return {
        category: cat,
        count: entry.count,
        pct: total_error_runs > 0 ? Math.round((entry.count / total_error_runs) * 10000) / 10000 : 0,
        sample_messages: entry.messages.slice(0, SAMPLE_MESSAGES_CAP),
        affected_connectors: Array.from(entry.connectors).sort(),
      };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  // Re-add zero-count categories at the end (for completeness).
  const zeroCats: ErrorCategoryRow[] = allCategories
    .filter((cat) => !categories.find((c) => c.category === cat))
    .map((cat) => ({
      category: cat,
      count: 0,
      pct: 0,
      sample_messages: [],
      affected_connectors: [],
    }));
  const allCategoryRows = [...categories, ...zeroCats];

  const most_common_error_category = categories.length > 0 ? categories[0].category : null;

  // Top-5 connectors by error count.
  const connectors_with_most_errors: ConnectorErrorCountRow[] = Array.from(
    connectorErrorCounts.entries(),
  )
    .map(([connector_id, { name, count }]) => ({ connector_id, name, error_count: count }))
    .sort((a, b) => b.error_count - a.error_count)
    .slice(0, TOP_CONNECTORS_CAP);

  const total_connectors_with_errors = connectorErrorCounts.size;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_error_runs,
    total_connectors_with_errors,
    categories: allCategoryRows,
    most_common_error_category,
    connectors_with_most_errors,
  };
}
