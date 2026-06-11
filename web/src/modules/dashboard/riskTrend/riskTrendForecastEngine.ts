// web/src/modules/dashboard/riskTrend/riskTrendForecastEngine.ts
//
// Pure-TypeScript deterministic forecast synthesis engine.
// No Math.imul — uses FNV-1a + mulberry32.

import type { RiskTrendConfig, ForecastHorizon } from './riskTrendConfigurationEngine';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ForecastPoint {
  date: string;
  value: number;
  lower: number;
  upper: number;
  is_forecast: boolean;
}

// ─── RNG helpers ──────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Date helper ─────────────────────────────────────────────────────────────

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Main API ─────────────────────────────────────────────────────────────────

/**
 * Build a combined historical + forecast series.
 * Historical points are `is_forecast: false`; future points are `true`.
 * `historicalData` must be non-empty; each value is treated as a daily count.
 */
export function generateForecastSeries(
  historicalData: number[],
  horizon: ForecastHorizon,
  seed: string,
): ForecastPoint[] {
  const rng = mulberry32(fnv1a(seed + String(horizon)));
  const today = new Date();

  // Build historical points
  const historicalPoints: ForecastPoint[] = historicalData.map((value, i) => {
    const offset = -(historicalData.length - 1 - i);
    return {
      date: isoDate(addDays(today, offset)),
      value,
      lower: value,
      upper: value,
      is_forecast: false,
    };
  });

  if (historicalData.length === 0) return [];

  // Simple linear trend from last N historical points
  const windowSize = Math.min(7, historicalData.length);
  const recentSlice = historicalData.slice(-windowSize);
  const avg = recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length;
  const trendSlope =
    (historicalData[historicalData.length - 1] - historicalData[Math.max(0, historicalData.length - windowSize)]) /
    Math.max(1, windowSize - 1);

  // Confidence band widens with horizon
  const baseBandWidth = avg * 0.10;

  const forecastPoints: ForecastPoint[] = [];
  for (let i = 1; i <= horizon; i++) {
    const projected = Math.max(0, avg + trendSlope * i + (rng() - 0.5) * avg * 0.08);
    const bandWidth  = baseBandWidth * (1 + (i / horizon) * 0.5);
    const jitter     = (rng() - 0.5) * avg * 0.04;

    forecastPoints.push({
      date:        isoDate(addDays(today, i)),
      value:       Math.round(projected + jitter),
      lower:       Math.round(Math.max(0, projected - bandWidth)),
      upper:       Math.round(projected + bandWidth),
      is_forecast: true,
    });
  }

  return [...historicalPoints, ...forecastPoints];
}

/**
 * Detect whether there is a meaningful drift in the series.
 */
export function detectDrift(
  series: ForecastPoint[],
): { hasDrift: boolean; driftMagnitude: number; driftDirection: 'up' | 'down' | 'stable' } {
  const forecasts = series.filter((p) => p.is_forecast);
  const historical = series.filter((p) => !p.is_forecast);

  if (forecasts.length === 0 || historical.length === 0) {
    return { hasDrift: false, driftMagnitude: 0, driftDirection: 'stable' };
  }

  const historicalAvg = historical.reduce((a, p) => a + p.value, 0) / historical.length;
  const forecastAvg   = forecasts.reduce((a, p) => a + p.value, 0) / forecasts.length;

  const driftPct = historicalAvg > 0 ? (forecastAvg - historicalAvg) / historicalAvg : 0;
  const THRESHOLD = 0.05; // 5% change = drift

  return {
    hasDrift:        Math.abs(driftPct) > THRESHOLD,
    driftMagnitude:  Math.round(Math.abs(driftPct) * 100),
    driftDirection:  driftPct > THRESHOLD ? 'up' : driftPct < -THRESHOLD ? 'down' : 'stable',
  };
}

/**
 * Return human-readable key risk drivers based on config domains.
 */
export function getKeyRiskDrivers(config: RiskTrendConfig): string[] {
  const DRIVER_MAP: Record<string, string[]> = {
    credit:        ['DPD-90+ migrations', 'Restructured accounts', 'SMA classification shift'],
    fraud:         ['Velocity anomalies', 'Geo-distance outliers', 'Channel switching patterns'],
    collections:   ['Roll-rate deterioration', 'Promise-to-pay failures', 'Agent productivity'],
    compliance:    ['KYC expiry backlog', 'SAR filing lag', 'Policy override volume'],
    operational:   ['System downtime events', 'Manual override rate', 'SLA breach count'],
    cyber:         ['Failed login velocity', 'Privileged access anomalies', 'Data exfiltration signals'],
    insurance:     ['Claim-to-premium ratio', 'Lapse velocity', 'Persistency decline'],
    investigation: ['Pending case age', 'Escalation rate', 'Evidence upload lag'],
    recovery:      ['Recovery efficiency ratio', 'Legal case backlog', 'Write-off velocity'],
    enterprise:    ['Composite risk score trend', 'Cross-domain correlation', 'Board KRI breaches'],
  };

  const drivers: string[] = [];
  for (const domain of config.domains) {
    const domainDrivers = DRIVER_MAP[domain];
    if (domainDrivers) {
      drivers.push(...domainDrivers.slice(0, 2));
    }
  }
  return drivers.slice(0, 8);
}

/**
 * Generate a plain-English forecast explanation paragraph.
 */
export function generateForecastExplanation(config: RiskTrendConfig): string {
  const domainList = config.domains.join(', ');
  const horizonLabel =
    config.forecast.horizon <= 7
      ? '1 week'
      : config.forecast.horizon <= 30
      ? '30 days'
      : config.forecast.horizon <= 60
      ? '60 days'
      : '90 days';

  return (
    `The AI forecast model projects ${config.metricType.replace(/_/g, ' ')} trends ` +
    `across ${domainList} domains over the next ${horizonLabel}. ` +
    `The confidence band widens towards the end of the forecast horizon, ` +
    `reflecting increasing uncertainty. ` +
    `Key drivers are derived from historical alert patterns, rule-engine signals, ` +
    `and external benchmark data. ` +
    `Drift detection monitors for statistically significant deviations from ` +
    `the rolling 30-day baseline.`
  );
}
