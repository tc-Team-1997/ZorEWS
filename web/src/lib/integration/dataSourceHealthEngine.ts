// dataSourceHealthEngine.ts
//
// ZorEWS — Data Source Health Engine
// Continuous health monitoring for all platform data sources.
// Tracks uptime, latency p50/p95, error rates, and SLA compliance.
//
// 100% additive — no existing logic changed.

import type { DataSourceId } from './liveDataAdapter';
import { probeAllSources, getSourceHealth } from './liveDataAdapter';

// ─── Types ────────────────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'degraded' | 'failing' | 'unknown' | 'demo_only';

export interface SlaTarget {
  p95LatencyMs: number;
  uptimeTarget: number;    // 0-1
  maxErrorRate: number;    // 0-1
}

export interface LatencySample {
  ts:       number;
  latencyMs: number;
  ok:       boolean;
}

export interface SourceHealthMetrics {
  sourceId:       DataSourceId;
  displayName:    string;
  category:       SourceCategory;
  status:         HealthStatus;
  uptime:         number;          // 0-1 (rolling window)
  errorRate:      number;          // 0-1
  p50LatencyMs:   number | null;
  p95LatencyMs:   number | null;
  slaTarget:      SlaTarget;
  slaCompliant:   boolean;
  lastOkAt:       string | null;
  lastFailAt:     string | null;
  consecutiveFails: number;
  samples:        LatencySample[];  // last 20 probes
  trend:          'improving' | 'stable' | 'degrading';
}

export type SourceCategory =
  | 'risk_data'
  | 'compliance'
  | 'operations'
  | 'ai_ml'
  | 'admin'
  | 'reporting'
  | 'integrations';

// ─── Source metadata ──────────────────────────────────────────────────────

export const SOURCE_METADATA: Record<DataSourceId, { displayName: string; category: SourceCategory; sla: SlaTarget }> = {
  alerts:           { displayName: 'Alert Engine',         category: 'risk_data',    sla: { p95LatencyMs: 800,  uptimeTarget: 0.995, maxErrorRate: 0.01 } },
  cases:            { displayName: 'Case Management',      category: 'operations',   sla: { p95LatencyMs: 1000, uptimeTarget: 0.990, maxErrorRate: 0.02 } },
  investigations:   { displayName: 'Investigation Center', category: 'operations',   sla: { p95LatencyMs: 1200, uptimeTarget: 0.990, maxErrorRate: 0.02 } },
  compliance:       { displayName: 'Compliance Engine',    category: 'compliance',   sla: { p95LatencyMs: 1500, uptimeTarget: 0.990, maxErrorRate: 0.02 } },
  recovery:         { displayName: 'Recovery Center',      category: 'operations',   sla: { p95LatencyMs: 1000, uptimeTarget: 0.985, maxErrorRate: 0.03 } },
  dashboard_kpis:   { displayName: 'Dashboard KPIs',       category: 'reporting',    sla: { p95LatencyMs: 2000, uptimeTarget: 0.995, maxErrorRate: 0.01 } },
  data_fabric:      { displayName: 'Data Fabric',          category: 'integrations', sla: { p95LatencyMs: 1500, uptimeTarget: 0.990, maxErrorRate: 0.02 } },
  executive_metrics: { displayName: 'Executive Metrics',   category: 'reporting',    sla: { p95LatencyMs: 2000, uptimeTarget: 0.990, maxErrorRate: 0.01 } },
  predictions:      { displayName: 'AI Predictions',       category: 'ai_ml',        sla: { p95LatencyMs: 1500, uptimeTarget: 0.990, maxErrorRate: 0.02 } },
  audit:            { displayName: 'Audit Trail',          category: 'compliance',   sla: { p95LatencyMs: 800,  uptimeTarget: 0.999, maxErrorRate: 0.001 } },
  iam:              { displayName: 'IAM & Tenants',        category: 'admin',        sla: { p95LatencyMs: 1000, uptimeTarget: 0.999, maxErrorRate: 0.01 } },
  rules:            { displayName: 'Rule Engine',          category: 'risk_data',    sla: { p95LatencyMs: 800,  uptimeTarget: 0.995, maxErrorRate: 0.01 } },
  scenarios:        { displayName: 'Scenario Simulator',   category: 'ai_ml',        sla: { p95LatencyMs: 3000, uptimeTarget: 0.985, maxErrorRate: 0.05 } },
  notifications:    { displayName: 'Notification Center',  category: 'operations',   sla: { p95LatencyMs: 1000, uptimeTarget: 0.990, maxErrorRate: 0.02 } },
};

// ─── In-memory sample store (last 20 probes per source) ──────────────────

const SAMPLE_WINDOW = 20;
const sampleStore = new Map<DataSourceId, LatencySample[]>();

function addSample(sourceId: DataSourceId, latencyMs: number, ok: boolean): void {
  const samples = sampleStore.get(sourceId) ?? [];
  samples.push({ ts: Date.now(), latencyMs, ok });
  if (samples.length > SAMPLE_WINDOW) samples.shift();
  sampleStore.set(sourceId, samples);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

// ─── Compute metrics from samples ─────────────────────────────────────────

function computeMetrics(sourceId: DataSourceId): Partial<SourceHealthMetrics> {
  const samples = sampleStore.get(sourceId) ?? [];
  if (samples.length === 0) return { status: 'unknown', uptime: 0, errorRate: 0, p50LatencyMs: null, p95LatencyMs: null };

  const okCount = samples.filter(s => s.ok).length;
  const uptime = okCount / samples.length;
  const errorRate = 1 - uptime;

  const okLatencies = samples.filter(s => s.ok).map(s => s.latencyMs).sort((a, b) => a - b);
  const p50 = okLatencies.length > 0 ? percentile(okLatencies, 50) : null;
  const p95 = okLatencies.length > 0 ? percentile(okLatencies, 95) : null;

  // Trend: compare first half vs second half success rate
  const mid = Math.floor(samples.length / 2);
  const firstHalf  = samples.slice(0, mid).filter(s => s.ok).length / (mid || 1);
  const secondHalf = samples.slice(mid).filter(s => s.ok).length / (samples.length - mid || 1);
  const trend: SourceHealthMetrics['trend'] = secondHalf > firstHalf + 0.1 ? 'improving' : secondHalf < firstHalf - 0.1 ? 'degrading' : 'stable';

  const sla = SOURCE_METADATA[sourceId]?.sla ?? { p95LatencyMs: 2000, uptimeTarget: 0.99, maxErrorRate: 0.02 };
  const slaCompliant = uptime >= sla.uptimeTarget && errorRate <= sla.maxErrorRate && (p95 === null || p95 <= sla.p95LatencyMs);

  let status: HealthStatus = 'healthy';
  if (uptime < 0.5) status = 'failing';
  else if (uptime < 0.8 || !slaCompliant) status = 'degraded';

  return { uptime, errorRate, p50LatencyMs: p50, p95LatencyMs: p95, slaCompliant, trend, status };
}

// ─── Main health engine ───────────────────────────────────────────────────

let probeInterval: ReturnType<typeof setInterval> | null = null;
const PROBE_INTERVAL_MS = 60_000; // probe every 60s

export function startHealthMonitoring(): void {
  if (probeInterval) return; // already running
  runProbe();                 // immediate first probe
  probeInterval = setInterval(runProbe, PROBE_INTERVAL_MS);
}

export function stopHealthMonitoring(): void {
  if (probeInterval) { clearInterval(probeInterval); probeInterval = null; }
}

async function runProbe(): Promise<void> {
  const records = await probeAllSources();
  for (const rec of records) {
    addSample(rec.source, rec.latencyMs ?? -1, rec.available);
  }
  window.dispatchEvent(new CustomEvent('zorews:health-update'));
}

// ─── Public API ───────────────────────────────────────────────────────────

export function getSourceMetrics(sourceId: DataSourceId): SourceHealthMetrics {
  const meta    = SOURCE_METADATA[sourceId];
  const health  = getSourceHealth(sourceId);
  const samples = sampleStore.get(sourceId) ?? [];
  const metrics = computeMetrics(sourceId);

  const lastOk   = [...samples].reverse().find(s => s.ok);
  const lastFail = [...samples].reverse().find(s => !s.ok);

  return {
    sourceId,
    displayName:     meta?.displayName ?? sourceId,
    category:        meta?.category ?? 'operations',
    slaTarget:       meta?.sla ?? { p95LatencyMs: 2000, uptimeTarget: 0.99, maxErrorRate: 0.02 },
    status:          health ? (health.available ? (metrics.status ?? 'healthy') : 'failing') : 'demo_only',
    uptime:          metrics.uptime ?? 0,
    errorRate:       metrics.errorRate ?? 0,
    p50LatencyMs:    metrics.p50LatencyMs ?? null,
    p95LatencyMs:    metrics.p95LatencyMs ?? null,
    slaCompliant:    metrics.slaCompliant ?? true,
    trend:           metrics.trend ?? 'stable',
    lastOkAt:        lastOk   ? new Date(lastOk.ts).toISOString()   : null,
    lastFailAt:      lastFail ? new Date(lastFail.ts).toISOString() : null,
    consecutiveFails: health?.consecutiveFails ?? 0,
    samples,
  };
}

export function getAllSourceMetrics(): SourceHealthMetrics[] {
  return Object.keys(SOURCE_METADATA).map(id => getSourceMetrics(id as DataSourceId));
}

export interface FleetHealthSummary {
  totalSources:    number;
  healthy:         number;
  degraded:        number;
  failing:         number;
  demoOnly:        number;
  slaCompliant:    number;
  overallStatus:   HealthStatus;
  p95AvgMs:        number | null;
  avgUptime:       number;
}

export function getFleetHealthSummary(): FleetHealthSummary {
  const metrics = getAllSourceMetrics();
  const total   = metrics.length;
  const healthy = metrics.filter(m => m.status === 'healthy').length;
  const degraded = metrics.filter(m => m.status === 'degraded').length;
  const failing  = metrics.filter(m => m.status === 'failing').length;
  const demoOnly = metrics.filter(m => m.status === 'demo_only').length;
  const slaCompliant = metrics.filter(m => m.slaCompliant).length;

  const p95s = metrics.map(m => m.p95LatencyMs).filter(v => v !== null) as number[];
  const p95Avg = p95s.length > 0 ? Math.round(p95s.reduce((a, b) => a + b, 0) / p95s.length) : null;
  const uptimes = metrics.map(m => m.uptime);
  const avgUptime = uptimes.reduce((a, b) => a + b, 0) / total;

  const healthPct = (healthy + demoOnly * 0.5) / total;
  const overallStatus: HealthStatus = healthPct >= 0.8 ? 'healthy' : healthPct >= 0.5 ? 'degraded' : 'failing';

  return { totalSources: total, healthy, degraded, failing, demoOnly, slaCompliant, overallStatus, p95AvgMs: p95Avg, avgUptime };
}
