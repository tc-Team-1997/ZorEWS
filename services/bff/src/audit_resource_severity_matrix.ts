// services/bff/src/audit_resource_severity_matrix.ts
//
// T6 M15.14 — Audit resource_type × severity cross-tab matrix.
//
// M15.9 ships per-severity distribution (1D pivot with by_resource_type
// nested inside each row). M15.12 ships per-resource_type distribution
// (1D pivot with by_severity inside). M15.14 elevates BOTH to the
// proper 2D matrix: rows = 10 AuditResourceType × cols = 3
// AuditSeverity = 30 cells. Each AuditEvent lives in exactly one cell
// (partition by definition).
//
// Mirror of M12.14 / M14.28 / M3.14 / M5.17 / M13.15 / M7.14 / M8.14
// matrix pattern for the audit-chain surface.
//
// Pure resolver — operates over the M15.1 store's listAll snapshot.
// Tenant-scoped at the caller.

import type {
  AuditEvent,
  AuditResourceType,
  AuditSeverity,
} from './audit_trail';

// ─── Canonical enum orders ────────────────────────────────────────────

export const ALL_AUDIT_SEVERITIES: readonly AuditSeverity[] = [
  'critical',
  'warning',
  'info',
] as const;

export const ALL_AUDIT_RESOURCE_TYPES: readonly AuditResourceType[] = [
  'user',
  'session',
  'config',
  'case',
  'alert',
  'report',
  'scenario',
  'rule',
  'integration',
  'system',
] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface AuditResourceSeverityCell {
  resource_type: AuditResourceType;
  severity: AuditSeverity;
  count: number;
}

export interface AuditResourceTypeRow {
  resource_type: AuditResourceType;
  total: number;
  by_severity: Record<AuditSeverity, number>;
  /** Severities never seen for this resource_type. Sorted in canonical
   *  ALL_AUDIT_SEVERITIES order — coverage-gap per resource_type. */
  severities_without: AuditSeverity[];
}

export interface AuditSeverityColumn {
  severity: AuditSeverity;
  total: number;
  by_resource_type: Record<AuditResourceType, number>;
  /** Resource types never seen at this severity. Sorted in canonical
   *  ALL_AUDIT_RESOURCE_TYPES order — coverage-gap per severity. */
  resource_types_without: AuditResourceType[];
}

export interface AuditResourceSeverityMatrix {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  rows: AuditResourceTypeRow[];
  columns: AuditSeverityColumn[];
  /** Peak cell — highest count (resource_type, severity). Canonical
   *  iteration tie-break (resource_types in ALL_AUDIT_RESOURCE_TYPES
   *  order × severities in ALL_AUDIT_SEVERITIES order: critical >
   *  warning > info). null when no events. */
  peak_cell: AuditResourceSeverityCell | null;
  /** Zero-count (resource_type, severity) pairs in canonical
   *  row-major order (resource_type asc index × severity asc index). */
  empty_cells: Array<{ resource_type: AuditResourceType; severity: AuditSeverity }>;
  /** Resource type with the most distinct non-zero severities.
   *  Canonical resource-type-order tie-break. null when no events. */
  most_severity_spread_type: {
    resource_type: AuditResourceType;
    severities_seen: number;
  } | null;
  /** Severity with the most distinct non-zero resource types.
   *  Canonical severity-order tie-break. null when no events. */
  most_resource_spread_severity: {
    severity: AuditSeverity;
    resource_types_seen: number;
  } | null;
  /** Total critical events across all resource types — convenience
   *  for SPA banner. 0 when no critical events. */
  total_critical: number;
  /** Resource types with ≥1 critical event. Sorted in canonical
   *  ALL_AUDIT_RESOURCE_TYPES order. Helps the SPA badge a "critical
   *  events landed in: user, config" headline. */
  resource_types_with_critical: AuditResourceType[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyBySeverity(): Record<AuditSeverity, number> {
  const out: Partial<Record<AuditSeverity, number>> = {};
  for (const s of ALL_AUDIT_SEVERITIES) out[s] = 0;
  return out as Record<AuditSeverity, number>;
}

function emptyByResource(): Record<AuditResourceType, number> {
  const out: Partial<Record<AuditResourceType, number>> = {};
  for (const r of ALL_AUDIT_RESOURCE_TYPES) out[r] = 0;
  return out as Record<AuditResourceType, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildAuditResourceSeverityMatrix(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditResourceSeverityMatrix {
  const cell = new Map<AuditResourceType, Map<AuditSeverity, number>>();
  for (const r of ALL_AUDIT_RESOURCE_TYPES) cell.set(r, new Map());

  let total_events = 0;
  for (const ev of events) {
    if (!ALL_AUDIT_RESOURCE_TYPES.includes(ev.resource_type)) continue;
    if (!ALL_AUDIT_SEVERITIES.includes(ev.severity)) continue;
    const inner = cell.get(ev.resource_type)!;
    inner.set(ev.severity, (inner.get(ev.severity) ?? 0) + 1);
    total_events++;
  }

  // Rows (resource_types × all severities).
  const rows: AuditResourceTypeRow[] = ALL_AUDIT_RESOURCE_TYPES.map((rt) => {
    const inner = cell.get(rt)!;
    const by_severity = emptyBySeverity();
    let total = 0;
    for (const s of ALL_AUDIT_SEVERITIES) {
      const c = inner.get(s) ?? 0;
      by_severity[s] = c;
      total += c;
    }
    const severities_without = ALL_AUDIT_SEVERITIES.filter((s) => by_severity[s] === 0);
    return { resource_type: rt, total, by_severity, severities_without };
  });

  // Columns (severities × all resource_types).
  const columns: AuditSeverityColumn[] = ALL_AUDIT_SEVERITIES.map((sev) => {
    const by_resource_type = emptyByResource();
    let total = 0;
    for (const r of ALL_AUDIT_RESOURCE_TYPES) {
      const c = cell.get(r)!.get(sev) ?? 0;
      by_resource_type[r] = c;
      total += c;
    }
    const resource_types_without = ALL_AUDIT_RESOURCE_TYPES.filter(
      (r) => by_resource_type[r] === 0,
    );
    return { severity: sev, total, by_resource_type, resource_types_without };
  });

  // peak_cell — canonical iteration tie-break.
  let peak: AuditResourceSeverityCell | null = null;
  for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
    for (const sev of ALL_AUDIT_SEVERITIES) {
      const count = cell.get(rt)!.get(sev) ?? 0;
      if (count > 0 && (!peak || count > peak.count)) {
        peak = { resource_type: rt, severity: sev, count };
      }
    }
  }

  // empty_cells canonical row-major (resource_type × severity).
  const empty_cells: Array<{ resource_type: AuditResourceType; severity: AuditSeverity }> = [];
  for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
    for (const sev of ALL_AUDIT_SEVERITIES) {
      const count = cell.get(rt)!.get(sev) ?? 0;
      if (count === 0) empty_cells.push({ resource_type: rt, severity: sev });
    }
  }

  // most_severity_spread_type — highest distinct non-zero by_severity
  // count.
  let bestRtSpan = 0;
  let mostSpreadRt: AuditResourceTypeRow | null = null;
  for (const row of rows) {
    const span = ALL_AUDIT_SEVERITIES.filter((s) => row.by_severity[s] > 0).length;
    if (span > bestRtSpan) {
      bestRtSpan = span;
      mostSpreadRt = row;
    }
  }
  const most_severity_spread_type = mostSpreadRt
    ? { resource_type: mostSpreadRt.resource_type, severities_seen: bestRtSpan }
    : null;

  // most_resource_spread_severity — highest distinct non-zero
  // by_resource_type count.
  let bestSevSpan = 0;
  let mostSpreadSev: AuditSeverityColumn | null = null;
  for (const col of columns) {
    const span = ALL_AUDIT_RESOURCE_TYPES.filter((r) => col.by_resource_type[r] > 0).length;
    if (span > bestSevSpan) {
      bestSevSpan = span;
      mostSpreadSev = col;
    }
  }
  const most_resource_spread_severity = mostSpreadSev
    ? { severity: mostSpreadSev.severity, resource_types_seen: bestSevSpan }
    : null;

  // total_critical + resource_types_with_critical.
  const criticalCol = columns.find((c) => c.severity === 'critical')!;
  const total_critical = criticalCol.total;
  const resource_types_with_critical = ALL_AUDIT_RESOURCE_TYPES.filter(
    (r) => criticalCol.by_resource_type[r] > 0,
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    most_severity_spread_type,
    most_resource_spread_severity,
    total_critical,
    resource_types_with_critical,
  };
}
