// services/bff/src/custom_dashboard_freshness.ts
//
// T6 M11.18 — Custom dashboard freshness rollup.
//
// Per-tenant analytics that surfaces how recently each saved dashboard
// was last touched. Drives:
//   - "this dashboard was last edited 6 months ago — verify it's still
//     relevant" governance review
//   - quarterly stale-content cleanup (per docs/bau-runbook.md monthly
//     checklist)
//   - SPA ribbon on /dashboards/custom showing the staleness chip
//
// Mirror of M13.11 (admin config override age) pattern for the
// dashboards surface. Same `recent / stable / stale` 3-bucket
// classification with operator-tunable thresholds.

import type { CustomDashboard } from './custom_dashboards';

// ─── Constants ───────────────────────────────────────────────────────

/** Default fresh_days threshold — dashboards updated within this many
 *  days fall into the `recent` bucket. */
export const DEFAULT_FRESH_DAYS = 30;

/** Default stale_days threshold — dashboards updated more than this
 *  many days ago fall into the `stale` bucket. Between fresh + stale
 *  is `stable`. */
export const DEFAULT_STALE_DAYS = 90;

/** Cap on the `stale_dashboards[]` envelope list — SPA gets the top-N
 *  most-stale dashboards for the "needs attention" panel. */
export const STALE_DASHBOARDS_CAP = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Errors ──────────────────────────────────────────────────────────

export class DashboardFreshnessError extends Error {
  override name = 'DashboardFreshnessError';
  constructor(public code: 'invalid_input', message: string) {
    super(message);
  }
}

// ─── Output shapes ────────────────────────────────────────────────────

export type FreshnessBucket = 'recent' | 'stable' | 'stale';

export interface DashboardFreshnessRow {
  dashboard_id: string;
  name: string;
  created_by: string;
  total_widgets: number;
  /** Floor((now − updated_at) / 86_400_000). */
  days_since_updated: number;
  /** Floor((now − created_at) / 86_400_000). */
  days_since_created: number;
  freshness: FreshnessBucket;
  updated_at: string;
  created_at: string;
  version: number;
}

export interface DashboardFreshnessReport {
  tenant_id: string;
  generated_at: string;
  /** Threshold values reflected in the response (echo of input). */
  fresh_days: number;
  stale_days: number;
  total_dashboards: number;
  recent_count: number;
  stable_count: number;
  stale_count: number;
  /** Mean days_since_updated across all dashboards (rounded); null
   *  when empty. */
  mean_days_since_updated: number | null;
  /** Dashboard with the largest days_since_updated; null on empty. */
  oldest_updated: DashboardFreshnessRow | null;
  /** Dashboard with the smallest days_since_updated; null on empty. */
  newest_updated: DashboardFreshnessRow | null;
  /** All rows sorted by days_since_updated desc + dashboard_id asc
   *  tie-break — oldest first. */
  dashboards: DashboardFreshnessRow[];
  /** Subset filtered to freshness='stale' — capped at
   *  STALE_DASHBOARDS_CAP. Sorted oldest-first within the cap. */
  stale_dashboards: DashboardFreshnessRow[];
}

// ─── Builder ──────────────────────────────────────────────────────────

function bucketFor(
  days_since_updated: number,
  fresh_days: number,
  stale_days: number,
): FreshnessBucket {
  // Strict-< on fresh boundary so exact fresh_days lands in `stable`.
  // Strict-> on stale boundary so exact stale_days lands in `stable`.
  // Mirrors the M13.11 admin_config_override_age semantics.
  if (days_since_updated < fresh_days) return 'recent';
  if (days_since_updated > stale_days) return 'stale';
  return 'stable';
}

export function summarizeDashboardFreshness(
  tenant_id: string,
  dashboards: readonly CustomDashboard[],
  now: Date,
  fresh_days: number = DEFAULT_FRESH_DAYS,
  stale_days: number = DEFAULT_STALE_DAYS,
): DashboardFreshnessReport {
  if (!Number.isInteger(fresh_days) || fresh_days < 0) {
    throw new DashboardFreshnessError(
      'invalid_input',
      'fresh_days must be a non-negative integer',
    );
  }
  if (!Number.isInteger(stale_days) || stale_days < 0) {
    throw new DashboardFreshnessError(
      'invalid_input',
      'stale_days must be a non-negative integer',
    );
  }
  if (stale_days < fresh_days) {
    throw new DashboardFreshnessError(
      'invalid_input',
      `stale_days (${stale_days}) must be >= fresh_days (${fresh_days})`,
    );
  }

  const nowMs = now.getTime();
  const rows: DashboardFreshnessRow[] = [];
  let recent_count = 0;
  let stable_count = 0;
  let stale_count = 0;
  let sumDays = 0;

  for (const dash of dashboards) {
    const updMs = new Date(dash.updated_at).getTime();
    const createdMs = new Date(dash.created_at).getTime();
    if (!Number.isFinite(updMs) || !Number.isFinite(createdMs)) continue;
    const days_since_updated = Math.max(0, Math.floor((nowMs - updMs) / MS_PER_DAY));
    const days_since_created = Math.max(0, Math.floor((nowMs - createdMs) / MS_PER_DAY));
    const freshness = bucketFor(days_since_updated, fresh_days, stale_days);
    if (freshness === 'recent') recent_count += 1;
    else if (freshness === 'stable') stable_count += 1;
    else stale_count += 1;
    sumDays += days_since_updated;
    rows.push({
      dashboard_id: dash.dashboard_id,
      name: dash.name,
      created_by: dash.created_by,
      total_widgets: dash.widgets.length,
      days_since_updated,
      days_since_created,
      freshness,
      updated_at: dash.updated_at,
      created_at: dash.created_at,
      version: dash.version,
    });
  }

  // Sort oldest-updated first; tie-break by dashboard_id asc for stable
  // SPA rendering.
  rows.sort((a, b) => {
    if (b.days_since_updated !== a.days_since_updated) {
      return b.days_since_updated - a.days_since_updated;
    }
    return a.dashboard_id < b.dashboard_id
      ? -1
      : a.dashboard_id > b.dashboard_id
        ? 1
        : 0;
  });

  const total_dashboards = rows.length;
  const mean_days_since_updated =
    total_dashboards === 0 ? null : Math.round(sumDays / total_dashboards);
  const oldest_updated = total_dashboards > 0 ? rows[0] : null;
  const newest_updated = total_dashboards > 0 ? rows[rows.length - 1] : null;
  const stale_dashboards = rows
    .filter((r) => r.freshness === 'stale')
    .slice(0, STALE_DASHBOARDS_CAP);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    fresh_days,
    stale_days,
    total_dashboards,
    recent_count,
    stable_count,
    stale_count,
    mean_days_since_updated,
    oldest_updated,
    newest_updated,
    dashboards: rows,
    stale_dashboards,
  };
}
