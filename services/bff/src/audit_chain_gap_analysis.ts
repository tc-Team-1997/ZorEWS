// services/bff/src/audit_chain_gap_analysis.ts
//
// T6 M15.26 — Audit chain gap analysis.
//
// Drain all audit events, sort by ts asc, find time gaps between
// consecutive events > 1 hour.
//
// gap_type: 'short'(<4h) | 'medium'(4-24h) | 'long'(>24h)
//
// Route: GET /v1/audit/chain-gap-analysis
//   RBAC: audit:read (admin)

import { defaultAuditTrailStore, type AuditTrailStore } from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

export type AuditGapType = 'short' | 'medium' | 'long';

export interface AuditChainGap {
  start_ts: string;
  end_ts: string;
  gap_hours: number;
  gap_type: AuditGapType;
}

export type CoverageHealth = 'good' | 'fair' | 'poor';

export interface AuditChainGapReport {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  gaps: AuditChainGap[];
  largest_gap_hours: number;
  avg_events_per_hour: number;
  coverage_health: CoverageHealth;
}

const GAP_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

function gapType(hours: number): AuditGapType {
  if (hours < 4) return 'short';
  if (hours <= 24) return 'medium';
  return 'long';
}

function coverageHealth(gap_count: number): CoverageHealth {
  if (gap_count < 3) return 'good';
  if (gap_count <= 10) return 'fair';
  return 'poor';
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildAuditChainGapAnalysis(
  store: AuditTrailStore,
  tenant_id: string,
  now: Date,
): AuditChainGapReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  // Drain all events
  const allEvents: Array<{ ts: string }> = [];
  let page = 1;
  const PAGE_SIZE = 500;
  for (;;) {
    const result = store.list(tenant_id, { page, page_size: PAGE_SIZE });
    allEvents.push(...result.items);
    if (result.items.length < PAGE_SIZE) break;
    page++;
    if (page > 200) break;
  }

  // Sort oldest first
  allEvents.sort((a, b) => a.ts.localeCompare(b.ts));

  const total_events = allEvents.length;
  const gaps: AuditChainGap[] = [];

  for (let i = 1; i < allEvents.length; i++) {
    const prev = new Date(allEvents[i - 1].ts).getTime();
    const curr = new Date(allEvents[i].ts).getTime();
    const gap_ms = curr - prev;
    if (gap_ms > GAP_THRESHOLD_MS) {
      const gap_hours = Math.round((gap_ms / 3600000) * 100) / 100;
      gaps.push({
        start_ts: allEvents[i - 1].ts,
        end_ts: allEvents[i].ts,
        gap_hours,
        gap_type: gapType(gap_hours),
      });
    }
  }

  const largest_gap_hours =
    gaps.length > 0
      ? Math.max(...gaps.map((g) => g.gap_hours))
      : 0;

  // Total span in hours
  let avg_events_per_hour = 0;
  if (allEvents.length >= 2) {
    const oldest = new Date(allEvents[0].ts).getTime();
    const newest = new Date(allEvents[allEvents.length - 1].ts).getTime();
    const span_hours = (newest - oldest) / 3600000;
    avg_events_per_hour =
      span_hours > 0 ? Math.round((total_events / span_hours) * 100) / 100 : total_events;
  } else if (allEvents.length === 1) {
    avg_events_per_hour = 1;
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events,
    gaps,
    largest_gap_hours,
    avg_events_per_hour,
    coverage_health: coverageHealth(gaps.length),
  };
}
