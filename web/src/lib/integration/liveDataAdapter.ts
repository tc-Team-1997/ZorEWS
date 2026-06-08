// liveDataAdapter.ts
//
// ZorEWS — Live Data Adapter
// Dual-mode data access layer: Demo Mode (deterministic synth) ↔ Live Enterprise Mode (BFF APIs).
//
// Architecture:
//   Mode A — Demo Mode:    All data from deterministic PRNG engines. Zero API calls.
//   Mode B — Live Mode:    Real BFF API calls with circuit-breaker fallback to Demo.
//   Mode C — Hybrid Mode:  Some sources live, others still demo (gradual migration).
//
// CRITICAL: Demo engines are NEVER removed. Live mode is ADDITIVE.
// If any live call fails → graceful fallback to demo data, no UX breakage.
//
// 100% additive — no existing logic changed.

import { http } from '@/lib/http';

// ─── Mode types ───────────────────────────────────────────────────────────

export type DataMode = 'demo' | 'live' | 'hybrid';

export type DataSourceId =
  | 'alerts'
  | 'cases'
  | 'investigations'
  | 'compliance'
  | 'recovery'
  | 'dashboard_kpis'
  | 'data_fabric'
  | 'executive_metrics'
  | 'predictions'
  | 'audit'
  | 'iam'
  | 'rules'
  | 'scenarios'
  | 'notifications';

// ─── Global mode config ───────────────────────────────────────────────────

const MODE_KEY = 'zorews.integration.mode';
const SOURCE_OVERRIDES_KEY = 'zorews.integration.source_overrides';

export function getGlobalMode(): DataMode {
  return (localStorage.getItem(MODE_KEY) as DataMode | null) ?? 'demo';
}

export function setGlobalMode(mode: DataMode): void {
  localStorage.setItem(MODE_KEY, mode);
  window.dispatchEvent(new CustomEvent('zorews:mode-change', { detail: { mode } }));
}

/** Per-source overrides — allow hybrid mode (some sources live, others demo) */
export function getSourceOverrides(): Partial<Record<DataSourceId, DataMode>> {
  try {
    const raw = localStorage.getItem(SOURCE_OVERRIDES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function setSourceMode(source: DataSourceId, mode: DataMode): void {
  const overrides = getSourceOverrides();
  overrides[source] = mode;
  localStorage.setItem(SOURCE_OVERRIDES_KEY, JSON.stringify(overrides));
}

export function getEffectiveMode(source: DataSourceId): DataMode {
  const overrides = getSourceOverrides();
  return overrides[source] ?? getGlobalMode();
}

export function resetToDemo(): void {
  localStorage.removeItem(MODE_KEY);
  localStorage.removeItem(SOURCE_OVERRIDES_KEY);
  window.dispatchEvent(new CustomEvent('zorews:mode-change', { detail: { mode: 'demo' } }));
}

// ─── Circuit breaker ──────────────────────────────────────────────────────

interface CircuitState {
  failures:    number;
  lastFailAt:  number;
  open:        boolean;
}

const CIRCUIT_THRESHOLD  = 3;        // failures before opening
const CIRCUIT_RESET_MS   = 30_000;   // 30s cool-down

const circuits = new Map<DataSourceId, CircuitState>();

function getCircuit(source: DataSourceId): CircuitState {
  if (!circuits.has(source)) {
    circuits.set(source, { failures: 0, lastFailAt: 0, open: false });
  }
  return circuits.get(source)!;
}

function recordSuccess(source: DataSourceId): void {
  const c = getCircuit(source);
  c.failures = 0;
  c.open = false;
}

function recordFailure(source: DataSourceId): void {
  const c = getCircuit(source);
  c.failures++;
  c.lastFailAt = Date.now();
  if (c.failures >= CIRCUIT_THRESHOLD) c.open = true;
}

function isCircuitOpen(source: DataSourceId): boolean {
  const c = getCircuit(source);
  if (!c.open) return false;
  if (Date.now() - c.lastFailAt > CIRCUIT_RESET_MS) {
    // Half-open: allow one retry
    c.open = false;
    c.failures = Math.max(0, c.failures - 1);
    return false;
  }
  return true;
}

export function getCircuitStatus(source: DataSourceId): 'closed' | 'open' | 'half-open' {
  const c = getCircuit(source);
  if (!c.open) return 'closed';
  if (Date.now() - c.lastFailAt > CIRCUIT_RESET_MS) return 'half-open';
  return 'open';
}

// ─── Live API endpoint map ────────────────────────────────────────────────

const LIVE_ENDPOINTS: Record<DataSourceId, string> = {
  alerts:           '/v1/alerts',
  cases:            '/api/cases',
  investigations:   '/v1/investigations/summary',
  compliance:       '/v1/admin/config/override-rate',
  recovery:         '/v1/ingestion/health',
  dashboard_kpis:   '/v1/dashboards/bil/executive',
  data_fabric:      '/v1/ingestion/health',
  executive_metrics: '/v1/dashboards/bil/executive',
  predictions:      '/v1/ai/models/type-coverage',
  audit:            '/v1/audit/summary',
  iam:              '/v1/tenants',
  rules:            '/v1/rules',
  scenarios:        '/v1/scenarios',
  notifications:    '/v1/notifications/template-usage',
};

// ─── Health tracking ──────────────────────────────────────────────────────

export interface SourceHealthRecord {
  source:          DataSourceId;
  lastCheckedAt:   string;
  latencyMs:       number | null;
  statusCode:      number | null;
  available:       boolean;
  consecutiveFails: number;
  circuitStatus:   'closed' | 'open' | 'half-open';
  effectiveMode:   DataMode;
}

const healthRecords = new Map<DataSourceId, SourceHealthRecord>();

function updateHealth(source: DataSourceId, latencyMs: number, statusCode: number, available: boolean): void {
  const c = getCircuit(source);
  healthRecords.set(source, {
    source,
    lastCheckedAt:    new Date().toISOString(),
    latencyMs,
    statusCode,
    available,
    consecutiveFails: c.failures,
    circuitStatus:    getCircuitStatus(source),
    effectiveMode:    getEffectiveMode(source),
  });
}

export function getAllHealthRecords(): SourceHealthRecord[] {
  return Array.from(healthRecords.values());
}

export function getSourceHealth(source: DataSourceId): SourceHealthRecord | undefined {
  return healthRecords.get(source);
}

// ─── Core adapter function ────────────────────────────────────────────────

export interface AdapterResult<T> {
  data:       T;
  source:     'live' | 'demo';
  latencyMs:  number;
  timestamp:  string;
  sourceId:   DataSourceId;
  error?:     string;
}

/**
 * Primary adapter function.
 * Checks mode → if demo or circuit open → returns demoFallback().
 * If live mode → calls live API with timeout → on failure → demoFallback().
 * All state is tracked for health/freshness monitoring.
 */
export async function adapt<T>(
  sourceId:     DataSourceId,
  demoFallback: () => T,
  liveCall?:    () => Promise<T>,
  timeoutMs    = 8_000,
): Promise<AdapterResult<T>> {
  const effectiveMode = getEffectiveMode(sourceId);
  const t0 = Date.now();
  const timestamp = new Date().toISOString();

  // Demo mode — always return synth data
  if (effectiveMode === 'demo' || !liveCall) {
    const data = demoFallback();
    updateHealth(sourceId, 0, 200, true);
    return { data, source: 'demo', latencyMs: 0, timestamp, sourceId };
  }

  // Circuit breaker open — fall back to demo, don't try API
  if (isCircuitOpen(sourceId)) {
    const data = demoFallback();
    updateHealth(sourceId, -1, 503, false);
    return { data, source: 'demo', latencyMs: -1, timestamp, sourceId, error: 'Circuit open — using demo data' };
  }

  // Live mode — attempt API call
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs),
    );
    const data = await Promise.race([liveCall(), timeoutPromise]);
    const latencyMs = Date.now() - t0;
    recordSuccess(sourceId);
    updateHealth(sourceId, latencyMs, 200, true);
    return { data, source: 'live', latencyMs, timestamp, sourceId };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    recordFailure(sourceId);
    const statusCode = (err as { status?: number }).status ?? 0;
    updateHealth(sourceId, latencyMs, statusCode, false);
    const data = demoFallback();
    return {
      data, source: 'demo', latencyMs, timestamp, sourceId,
      error: `Live API failed (${statusCode || 'timeout'}) — using demo data`,
    };
  }
}

// ─── Probe (health check without data retrieval) ──────────────────────────

export async function probeSource(source: DataSourceId, timeoutMs = 5_000): Promise<SourceHealthRecord> {
  const t0 = Date.now();
  const endpoint = LIVE_ENDPOINTS[source];
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs),
    );
    const res = await Promise.race([
      http.get(endpoint, { validateStatus: () => true }),
      timeoutPromise,
    ]);
    const latencyMs = Date.now() - t0;
    const available = (res as { status: number }).status < 500;
    const statusCode = (res as { status: number }).status;
    if (available) recordSuccess(source); else recordFailure(source);
    updateHealth(source, latencyMs, statusCode, available);
  } catch {
    const latencyMs = Date.now() - t0;
    recordFailure(source);
    updateHealth(source, latencyMs, 0, false);
  }
  return healthRecords.get(source) ?? {
    source, lastCheckedAt: new Date().toISOString(),
    latencyMs: null, statusCode: null, available: false,
    consecutiveFails: 0, circuitStatus: 'closed', effectiveMode: getEffectiveMode(source),
  };
}

// ─── Bulk probe (run all sources in parallel) ─────────────────────────────

export async function probeAllSources(): Promise<SourceHealthRecord[]> {
  const sources = Object.keys(LIVE_ENDPOINTS) as DataSourceId[];
  const results = await Promise.allSettled(sources.map(s => probeSource(s)));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : healthRecords.get(sources[i]!) ?? {
          source: sources[i]!, lastCheckedAt: new Date().toISOString(),
          latencyMs: null, statusCode: null, available: false,
          consecutiveFails: 0, circuitStatus: 'open' as const, effectiveMode: 'demo' as const,
        },
  );
}

// ─── Mode summary ─────────────────────────────────────────────────────────

export interface ModeSummary {
  globalMode:    DataMode;
  sourcesLive:   number;
  sourcesDemo:   number;
  sourcesHybrid: number;
  totalSources:  number;
  availableLive: number;
  overallHealth: 'healthy' | 'degraded' | 'critical';
}

export function getModeSummary(): ModeSummary {
  const sources = Object.keys(LIVE_ENDPOINTS) as DataSourceId[];
  const overrides = getSourceOverrides();
  const globalMode = getGlobalMode();

  let live = 0, demo = 0, hybrid = 0, availableLive = 0;
  for (const s of sources) {
    const m = overrides[s] ?? globalMode;
    if (m === 'live') { live++; if (healthRecords.get(s)?.available) availableLive++; }
    else if (m === 'demo') demo++;
    else hybrid++;
  }

  const healthPct = live > 0 ? availableLive / live : 1;
  const overallHealth = healthPct >= 0.8 ? 'healthy' : healthPct >= 0.5 ? 'degraded' : 'critical';

  return {
    globalMode, sourcesLive: live, sourcesDemo: demo, sourcesHybrid: hybrid,
    totalSources: sources.length, availableLive, overallHealth,
  };
}
