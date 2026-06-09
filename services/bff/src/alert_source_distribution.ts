// services/bff/src/alert_source_distribution.ts
//
// T6 M8.20 — Alert source system distribution.
//
// Groups routed alerts by their source severity (severity_in field
// from the routing ledger) to surface the RAW upstream mix before
// the M8.1 classification step. This answers "where do our alerts
// come from?" in terms of severity — how many were LOW / MEDIUM /
// HIGH / CRITICAL at the source, and how do they map to BIL classes?
//
// Also computes a "mapping accuracy" metric: what % of records have
// the expected LOW→green / MEDIUM→yellow / HIGH→orange / CRITICAL→red
// mapping, giving ops a health check on the classifier.

import type { BilAlertClass } from './bil_alert_classification';
import type { RoutedAlertRecord } from './alert_routing_analytics';

// ─── Public types ──────────────────────────────────────────────────────

export interface SourceSeverityRow {
  severity: string;
  count: number;
  pct: number;
  by_class: Record<BilAlertClass, number>;
  acked_count: number;
  open_count: number;
}

export interface AlertSourceDistributionResult {
  tenant_id: string;
  generated_at: string;
  window: number;
  total_records: number;
  /** Rows sorted by count desc; each distinct severity_in value gets a row. */
  by_source_severity: SourceSeverityRow[];
  /** Severity with the highest count; null on empty. */
  dominant_source_severity: string | null;
  /** % of records where the severity→class mapping matched the
   *  canonical LOW→green, MEDIUM→yellow, HIGH→orange, CRITICAL→red
   *  mapping. null when no records. */
  severity_to_class_mapping_accuracy: number | null;
}

// ─── Constants ─────────────────────────────────────────────────────────

const ALL_CLASSES: readonly BilAlertClass[] = ['red', 'orange', 'yellow', 'green'];

const EXPECTED_CLASS: Record<string, BilAlertClass> = {
  LOW: 'green',
  MEDIUM: 'yellow',
  HIGH: 'orange',
  CRITICAL: 'red',
};

// ─── Pure function ─────────────────────────────────────────────────────

export function buildAlertSourceDistribution(
  tenant_id: string,
  records: RoutedAlertRecord[],
  window: number,
  now: Date,
): AlertSourceDistributionResult {
  if (!tenant_id || typeof tenant_id !== 'string') {
    throw new Error('tenant_id is required');
  }

  const total = records.length;
  const dominant_source_severity: string | null = null;

  if (total === 0) {
    return {
      tenant_id,
      generated_at: now.toISOString(),
      window,
      total_records: 0,
      by_source_severity: [],
      dominant_source_severity: null,
      severity_to_class_mapping_accuracy: null,
    };
  }

  // Group by severity_in (normalise to uppercase for matching)
  const grouped = new Map<
    string,
    { count: number; by_class: Record<BilAlertClass, number>; acked: number; open: number }
  >();

  let correct_mappings = 0;

  for (const rec of records) {
    const sev = rec.severity_in ?? 'UNKNOWN';
    if (!grouped.has(sev)) {
      const by_class = {} as Record<BilAlertClass, number>;
      for (const c of ALL_CLASSES) by_class[c] = 0;
      grouped.set(sev, { count: 0, by_class, acked: 0, open: 0 });
    }
    const row = grouped.get(sev)!;
    row.count++;
    if (ALL_CLASSES.includes(rec.class)) {
      row.by_class[rec.class]++;
    }
    if (rec.acked_at !== null) {
      row.acked++;
    } else {
      row.open++;
    }
    // Check canonical mapping
    const expected = EXPECTED_CLASS[sev.toUpperCase()];
    if (expected && rec.class === expected) {
      correct_mappings++;
    }
  }

  // Build rows sorted by count desc
  const rows: SourceSeverityRow[] = [...grouped.entries()]
    .map(([sev, data]) => ({
      severity: sev,
      count: data.count,
      pct: data.count / total,
      by_class: data.by_class,
      acked_count: data.acked,
      open_count: data.open,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.severity.localeCompare(b.severity);
    });

  const dom =
    rows.length > 0 ? rows[0].severity : null;

  // mapping accuracy over records where we have a known expected mapping
  const known = records.filter((r) =>
    EXPECTED_CLASS[(r.severity_in ?? '').toUpperCase()] !== undefined,
  ).length;

  const accuracy = known > 0 ? correct_mappings / known : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    window,
    total_records: total,
    by_source_severity: rows,
    dominant_source_severity: dom,
    severity_to_class_mapping_accuracy: accuracy,
  };
}
