// dataFreshnessEngine.ts
//
// ZorEWS — Data Freshness Engine
// Tracks when each data source was last refreshed and whether it is within SLA.
// Surfaces stale data warnings before they impact risk decisions.
//
// 100% additive — no existing logic changed.

import type { DataSourceId } from './liveDataAdapter';
import { getEffectiveMode } from './liveDataAdapter';

// ─── Types ────────────────────────────────────────────────────────────────

export type FreshnessStatus = 'fresh' | 'aging' | 'stale' | 'critical' | 'unknown';

export interface FreshnessConfig {
  /** Expected refresh interval (ms). Data older than this is "aging". */
  expectedIntervalMs: number;
  /** Max acceptable age (ms). Older than this is "stale". */
  maxAgeMs: number;
  /** Critical threshold (ms). Data older than this may cause wrong decisions. */
  criticalAgeMs: number;
  /** Human-readable interval description */
  intervalLabel: string;
}

export interface FreshnessRecord {
  sourceId:        DataSourceId;
  displayName:     string;
  lastRefreshedAt: string | null;   // ISO
  ageMs:           number | null;
  status:          FreshnessStatus;
  expectedInterval: string;
  nextExpectedAt:  string | null;   // ISO
  source:          'live' | 'demo' | 'unknown';
  refreshCount:    number;
  avgRefreshIntervalMs: number | null;
}

// ─── Freshness configs per source ─────────────────────────────────────────

const FRESHNESS_CONFIGS: Record<DataSourceId, FreshnessConfig> = {
  alerts:           { expectedIntervalMs: 60_000,       maxAgeMs: 300_000,       criticalAgeMs: 600_000,       intervalLabel: '1 minute' },
  cases:            { expectedIntervalMs: 300_000,      maxAgeMs: 900_000,       criticalAgeMs: 1_800_000,     intervalLabel: '5 minutes' },
  investigations:   { expectedIntervalMs: 300_000,      maxAgeMs: 900_000,       criticalAgeMs: 1_800_000,     intervalLabel: '5 minutes' },
  compliance:       { expectedIntervalMs: 3_600_000,    maxAgeMs: 7_200_000,     criticalAgeMs: 86_400_000,    intervalLabel: '1 hour' },
  recovery:         { expectedIntervalMs: 1_800_000,    maxAgeMs: 3_600_000,     criticalAgeMs: 14_400_000,    intervalLabel: '30 minutes' },
  dashboard_kpis:   { expectedIntervalMs: 60_000,       maxAgeMs: 300_000,       criticalAgeMs: 900_000,       intervalLabel: '1 minute' },
  data_fabric:      { expectedIntervalMs: 3_600_000,    maxAgeMs: 7_200_000,     criticalAgeMs: 14_400_000,    intervalLabel: '1 hour' },
  executive_metrics: { expectedIntervalMs: 300_000,     maxAgeMs: 900_000,       criticalAgeMs: 1_800_000,     intervalLabel: '5 minutes' },
  predictions:      { expectedIntervalMs: 86_400_000,   maxAgeMs: 172_800_000,   criticalAgeMs: 259_200_000,   intervalLabel: '24 hours' },
  audit:            { expectedIntervalMs: 1_000,        maxAgeMs: 60_000,        criticalAgeMs: 300_000,       intervalLabel: 'Real-time' },
  iam:              { expectedIntervalMs: 3_600_000,    maxAgeMs: 7_200_000,     criticalAgeMs: 86_400_000,    intervalLabel: '1 hour' },
  rules:            { expectedIntervalMs: 3_600_000,    maxAgeMs: 7_200_000,     criticalAgeMs: 86_400_000,    intervalLabel: '1 hour' },
  scenarios:        { expectedIntervalMs: 86_400_000,   maxAgeMs: 172_800_000,   criticalAgeMs: 604_800_000,   intervalLabel: '24 hours' },
  notifications:    { expectedIntervalMs: 60_000,       maxAgeMs: 300_000,       criticalAgeMs: 600_000,       intervalLabel: '1 minute' },
};

const SOURCE_DISPLAY_NAMES: Partial<Record<DataSourceId, string>> = {
  alerts:           'Alert Engine',
  cases:            'Case Management',
  investigations:   'Investigations',
  compliance:       'Compliance Engine',
  recovery:         'Recovery Center',
  dashboard_kpis:   'Dashboard KPIs',
  data_fabric:      'Data Fabric',
  executive_metrics: 'Executive Metrics',
  predictions:      'AI Predictions',
  audit:            'Audit Trail',
  iam:              'IAM & Tenants',
  rules:            'Rule Engine',
  scenarios:        'Scenario Simulator',
  notifications:    'Notifications',
};

// ─── Refresh event store ──────────────────────────────────────────────────

interface RefreshEvent {
  ts:     number;
  source: 'live' | 'demo';
}

const refreshHistory = new Map<DataSourceId, RefreshEvent[]>();
const MAX_HISTORY = 50;

export function recordRefresh(sourceId: DataSourceId, source: 'live' | 'demo'): void {
  const history = refreshHistory.get(sourceId) ?? [];
  history.push({ ts: Date.now(), source });
  if (history.length > MAX_HISTORY) history.shift();
  refreshHistory.set(sourceId, history);
  window.dispatchEvent(new CustomEvent('zorews:freshness-update', { detail: { sourceId } }));
}

// ─── Core freshness computation ───────────────────────────────────────────

function computeFreshnessStatus(ageMs: number, config: FreshnessConfig): FreshnessStatus {
  if (ageMs >= config.criticalAgeMs) return 'critical';
  if (ageMs >= config.maxAgeMs)      return 'stale';
  if (ageMs >= config.expectedIntervalMs) return 'aging';
  return 'fresh';
}

function avgInterval(events: RefreshEvent[]): number | null {
  if (events.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < events.length; i++) {
    intervals.push(events[i]!.ts - events[i - 1]!.ts);
  }
  return intervals.reduce((a, b) => a + b, 0) / intervals.length;
}

// ─── Public API ───────────────────────────────────────────────────────────

export function getFreshnessRecord(sourceId: DataSourceId): FreshnessRecord {
  const config  = FRESHNESS_CONFIGS[sourceId];
  const history = refreshHistory.get(sourceId) ?? [];
  const last    = history.at(-1);

  if (!config) {
    return {
      sourceId, displayName: SOURCE_DISPLAY_NAMES[sourceId] ?? sourceId,
      lastRefreshedAt: null, ageMs: null, status: 'unknown',
      expectedInterval: 'unknown', nextExpectedAt: null, source: 'unknown', refreshCount: 0,
      avgRefreshIntervalMs: null,
    };
  }

  const ageMs       = last ? Date.now() - last.ts : null;
  const status      = ageMs !== null ? computeFreshnessStatus(ageMs, config) : 'unknown';
  const nextExpected = last ? new Date(last.ts + config.expectedIntervalMs).toISOString() : null;
  const avgMs       = avgInterval(history);
  const effectiveMode = getEffectiveMode(sourceId);

  return {
    sourceId,
    displayName:     SOURCE_DISPLAY_NAMES[sourceId] ?? sourceId,
    lastRefreshedAt: last ? new Date(last.ts).toISOString() : null,
    ageMs,
    status: effectiveMode === 'demo' && status === 'unknown' ? 'fresh' : status,
    expectedInterval: config.intervalLabel,
    nextExpectedAt:   nextExpected,
    source:           last?.source ?? (effectiveMode === 'demo' ? 'demo' : 'unknown'),
    refreshCount:     history.length,
    avgRefreshIntervalMs: avgMs,
  };
}

export function getAllFreshnessRecords(): FreshnessRecord[] {
  return Object.keys(FRESHNESS_CONFIGS).map(id => getFreshnessRecord(id as DataSourceId));
}

// ─── Freshness fleet summary ──────────────────────────────────────────────

export interface FreshnessFleetSummary {
  total:    number;
  fresh:    number;
  aging:    number;
  stale:    number;
  critical: number;
  unknown:  number;
  freshPct: number;
  staleSources: DataSourceId[];
  criticalSources: DataSourceId[];
}

export function getFreshnessFleetSummary(): FreshnessFleetSummary {
  const records = getAllFreshnessRecords();
  const counts = { fresh: 0, aging: 0, stale: 0, critical: 0, unknown: 0 };
  const staleSources: DataSourceId[] = [];
  const criticalSources: DataSourceId[] = [];

  for (const r of records) {
    counts[r.status]++;
    if (r.status === 'stale') staleSources.push(r.sourceId);
    if (r.status === 'critical') criticalSources.push(r.sourceId);
  }

  const total = records.length;
  const goodCount = counts.fresh + counts.aging;
  return {
    total, ...counts,
    freshPct: goodCount / total,
    staleSources, criticalSources,
  };
}

// ─── Human-readable age ───────────────────────────────────────────────────

export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return 'Never';
  if (ageMs < 0) return 'Now';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60)  return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// ─── Freshness status colors (for UI) ────────────────────────────────────

export const FRESHNESS_COLORS: Record<FreshnessStatus, { bg: string; text: string; dot: string }> = {
  fresh:    { bg: 'bg-green-50',   text: 'text-green-700',  dot: 'bg-green-500' },
  aging:    { bg: 'bg-amber-50',   text: 'text-amber-700',  dot: 'bg-amber-400' },
  stale:    { bg: 'bg-orange-50',  text: 'text-orange-700', dot: 'bg-orange-500' },
  critical: { bg: 'bg-red-50',     text: 'text-red-700',    dot: 'bg-red-600' },
  unknown:  { bg: 'bg-[#F3F4F6]',  text: 'text-[#9CA3AF]',  dot: 'bg-[#D1D5DB]' },
};
